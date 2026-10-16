// Gemini generateContent / streamGenerateContent -> Anthropic Messages
// response and Anthropic SSE events.

import type {
  AnthropicContentBlock,
  AnthropicMessageResponse,
  AnthropicToolUseBlock,
  AnthropicUsage,
  GeminiFunctionCallPart,
  GeminiPart,
  GeminiResponse,
  GeminiTextPart,
} from "./types.ts";
import type { SignatureStore } from "./signature.ts";

const STOP_REASON: Record<string, AnthropicMessageResponse["stop_reason"]> = {
  STOP: "end_turn",
  MAX_TOKENS: "max_tokens",
  SAFETY: "end_turn",
  RECITATION: "end_turn",
  OTHER: "end_turn",
};

function mapStopReason(
  finishReason: string | undefined,
  sawToolUse: boolean,
): AnthropicMessageResponse["stop_reason"] {
  if (sawToolUse) return "tool_use";
  if (!finishReason) return "end_turn";
  return STOP_REASON[finishReason] ?? "end_turn";
}

function usageOf(resp: GeminiResponse): AnthropicUsage {
  const u = resp.usageMetadata;
  return {
    input_tokens: u?.promptTokenCount ?? 0,
    output_tokens: u?.candidatesTokenCount ?? 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function isFunctionCall(p: GeminiPart): p is GeminiFunctionCallPart {
  return typeof p === "object" && p !== null && "functionCall" in p;
}

function isTextPart(p: GeminiPart): p is GeminiTextPart {
  return typeof p === "object" && p !== null && "text" in p;
}

function isThoughtOnly(
  p: GeminiPart,
): p is { thought: true; thoughtSignature: string } {
  return (
    typeof p === "object" &&
    p !== null &&
    "thought" in p &&
    (p as { thought?: boolean }).thought === true &&
    !("text" in p) &&
    !("functionCall" in p)
  );
}

/**
 * Attach a signature to content blocks, per @the-next-ai/ai-gateway's JD():
 * walk backwards looking for a thinking block to stamp; otherwise append a
 * fresh empty thinking block carrying the signature.
 */
export function attachSignature(
  blocks: AnthropicContentBlock[],
  signature: string,
): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "thinking") {
      b.signature = signature;
      return;
    }
    if (b.type !== "redacted_thinking") break;
  }
  blocks.push({ type: "thinking", thinking: "", signature });
}

/** Convert one Gemini candidate's parts into Anthropic content blocks. */
export function partsToBlocks(
  parts: GeminiPart[],
  store: SignatureStore | undefined,
  idGen: () => string,
): { blocks: AnthropicContentBlock[]; sawToolUse: boolean } {
  const blocks: AnthropicContentBlock[] = [];
  let sawToolUse = false;

  for (const part of parts) {
    if (isThoughtOnly(part)) {
      attachSignature(blocks, part.thoughtSignature);
      continue;
    }

    if (isTextPart(part)) {
      // Signatures on text parts are not round-trip-required (verified
      // against the upstream); only tool-call signatures matter and they
      // are carried on their own parts. Drop text-part signatures rather
      // than emitting thinking blocks that reorder content.
      if (part.text) blocks.push({ type: "text", text: part.text });
      continue;
    }

    if (isFunctionCall(part)) {
      sawToolUse = true;
      const sig = part.thoughtSignature;
      const call = part.functionCall;
      const toolUse: AnthropicToolUseBlock = {
        type: "tool_use",
        id: call.id || idGen(),
        name: call.name,
        input: (call.args ?? {}) as Record<string, unknown>,
      };
      if (sig) {
        attachSignature(blocks, sig);
        store?.put(toolUse.id, sig);
      }
      blocks.push(toolUse);
      continue;
    }

    // functionResponse parts are never model output; ignore defensively.
  }

  return { blocks, sawToolUse };
}

export function toAnthropicResponse(
  resp: GeminiResponse,
  model: string,
  opts: { store?: SignatureStore; idGen?: () => string } = {},
): AnthropicMessageResponse {
  const idGen = opts.idGen ?? defaultIdGen;
  const candidate = resp.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const { blocks, sawToolUse } = partsToBlocks(parts, opts.store, idGen);

  return {
    id: idGen(),
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: mapStopReason(candidate?.finishReason, sawToolUse),
    stop_sequence: null,
    usage: usageOf(resp),
  };
}

export function defaultIdGen(): string {
  return "msg_" + Math.random().toString(36).slice(2, 14);
}

// ---------- SSE streaming ----------

export type AnthropicSSEEvent = { event: string; data: unknown };

/**
 * Incremental converter: feed Gemini streamGenerateContent chunks, receive
 * Anthropic SSE event batches. Tool inputs arrive whole from Gemini, so they
 * are emitted as a single input_json_delta (valid per the wire spec — clients
 * must tolerate partial_json coalescing).
 */
export class AnthropicStreamAssembler {
  private blocks: AnthropicContentBlock[] = [];
  private openIndex = -1;
  private openKind: "text" | "thinking" | "tool_use" | null = null;
  private started = false;
  private finished = false;
  private sawToolUse = false;
  private stopReason: string | undefined;
  private usage: AnthropicUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  private readonly model: string;
  private readonly store: SignatureStore | undefined;
  private readonly idGen: () => string;
  private readonly messageId: string;
  /** Pending signature to flush as its own thinking block. */
  private pendingSignature: string | undefined;

  constructor(opts: { model: string; store?: SignatureStore; idGen?: () => string }) {
    this.model = opts.model;
    this.store = opts.store;
    this.idGen = opts.idGen ?? defaultIdGen;
    this.messageId = this.idGen();
  }

  /** Convert one upstream chunk into zero or more SSE events. */
  push(chunk: GeminiResponse): AnthropicSSEEvent[] {
    const events: AnthropicSSEEvent[] = [];
    if (this.finished) return events;

    if (!this.started) {
      this.started = true;
      events.push({
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: this.messageId,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: chunk.usageMetadata?.promptTokenCount ?? 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      });
    }

    if (chunk.usageMetadata) {
      this.usage = usageOf(chunk);
    }

    const candidate = chunk.candidates?.[0];
    if (!candidate) return events;
    if (candidate.finishReason) this.stopReason = candidate.finishReason;

    for (const part of candidate.content?.parts ?? []) {
      events.push(...this.consumePart(part));
    }
    return events;
  }

  private consumePart(part: GeminiPart): AnthropicSSEEvent[] {
    const events: AnthropicSSEEvent[] = [];

    if (isThoughtOnly(part)) {
      this.pendingSignature = part.thoughtSignature;
      return events;
    }

    if (isTextPart(part)) {
      const sig = part.thoughtSignature;
      if (sig) this.pendingSignature = sig;
      if (!part.text) {
        // Empty text carrying only a signature: flush signature later.
        return events;
      }
      if ((part as { thought?: boolean }).thought === true) {
        events.push(...this.openThinking(part.text));
        return events;
      }
      // Reuse the open text block so consecutive chunks merge into one.
      if (this.openKind !== "text") {
        events.push(...this.openText());
      }
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.openIndex,
          delta: { type: "text_delta", text: part.text },
        },
      });
      return events;
    }

    if (isFunctionCall(part)) {
      const sig = part.thoughtSignature ?? this.pendingSignature;
      this.pendingSignature = undefined;
      if (sig) {
        events.push(...this.openThinking("", sig));
        events.push(...this.closeOpen());
      }
      this.sawToolUse = true;
      const call = part.functionCall;
      const id = call.id || this.idGen();
      if (sig) this.store?.put(id, sig);

      events.push(...this.closeOpen());
      this.openKind = "tool_use";
      this.openIndex = this.blocks.length;
      const block: AnthropicToolUseBlock = {
        type: "tool_use",
        id,
        name: call.name,
        input: (call.args ?? {}) as Record<string, unknown>,
      };
      this.blocks.push(block);
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.openIndex,
          content_block: { type: "tool_use", id, name: call.name, input: {} },
        },
      });
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.openIndex,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(call.args ?? {}),
          },
        },
      });
      return events;
    }

    return events;
  }

  private openText(): AnthropicSSEEvent[] {
    const events = this.closeOpen();
    this.openKind = "text";
    this.openIndex = this.blocks.length;
    this.blocks.push({ type: "text", text: "" });
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: this.openIndex,
        content_block: { type: "text", text: "" },
      },
    });
    return events;
  }

  private openThinking(
    text: string,
    signature?: string,
  ): AnthropicSSEEvent[] {
    const events = this.closeOpen();
    this.openKind = "thinking";
    this.openIndex = this.blocks.length;
    this.blocks.push({
      type: "thinking",
      thinking: text,
      signature: signature ?? "",
    });
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: this.openIndex,
        content_block: { type: "thinking", thinking: "" },
      },
    });
    if (text) {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.openIndex,
          delta: { type: "thinking_delta", thinking: text },
        },
      });
    }
    if (signature) {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.openIndex,
          delta: { type: "signature_delta", signature },
        },
      });
    }
    return events;
  }

  private closeOpen(): AnthropicSSEEvent[] {
    if (this.openKind === null) return [];
    const index = this.openIndex;
    this.openKind = null;
    this.openIndex = -1;
    return [
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index },
      },
    ];
  }

  /** Emit the closing events. Call exactly once after the last chunk. */
  finish(): AnthropicSSEEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const events: AnthropicSSEEvent[] = [];

    // A trailing signature on a text-only turn is dropped: the upstream
    // accepts text turns without it (verified), and emitting a trailing
    // thinking block after the text confuses clients that expect thinking
    // blocks to precede content. Signatures that matter (tool calls) are
    // already attached before their tool_use block and cached by id.
    this.pendingSignature = undefined;

    events.push(...this.closeOpen());
    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: mapStopReason(this.stopReason, this.sawToolUse),
          stop_sequence: null,
        },
        usage: {
          input_tokens: this.usage.input_tokens,
          output_tokens: this.usage.output_tokens,
          cache_read_input_tokens: this.usage.cache_read_input_tokens,
          cache_creation_input_tokens: this.usage.cache_creation_input_tokens,
        },
      },
    });
    events.push({ event: "message_stop", data: { type: "message_stop" } });
    return events;
  }
}
