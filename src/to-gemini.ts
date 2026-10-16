// Anthropic Messages request -> Gemini generateContent request.
//
// Thinking/signature handling follows the pattern extracted from
// @the-next-ai/ai-gateway: a `thinking` block's signature is held as
// "pending" and stamped onto the next functionCall part; a leftover pending
// signature is emitted as a bare {thought:true, thoughtSignature} part so the
// upstream can still verify the turn.

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageRequest,
  AnthropicTextBlock,
  GeminiContent,
  GeminiPart,
  GeminiRequest,
} from "./types.ts";
import type { SignatureStore } from "./signature.ts";

export type ThinkingLevel = "LOW" | "MEDIUM" | "HIGH";

export type ToGeminiOptions = {
  store: SignatureStore;
  /** Default thinking level when the request does not specify one. Defaults to HIGH. */
  defaultThinkingLevel?: ThinkingLevel | "OFF";
};

function resolveThinkingLevel(
  req: AnthropicMessageRequest,
  fallback: ThinkingLevel | "OFF" = "HIGH",
): ThinkingLevel | undefined {
  if (req.thinking?.type === "disabled") return "LOW";
  const effort = req.output_config?.effort;
  if (effort === "low") return "LOW";
  if (effort === "medium") return "MEDIUM";
  if (effort === "high" || effort === "xhigh" || effort === "max") {
    return "HIGH";
  }
  if (fallback === "OFF") return undefined;
  return fallback;
}

export function textOf(content: string | AnthropicTextBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((b) => b.text).join("");
}

/** Flatten Anthropic system field into a plain string. */
function systemText(system: AnthropicMessageRequest["system"]): string {
  if (!system) return "";
  return textOf(system);
}

export function toGeminiRequest(
  req: AnthropicMessageRequest,
  opts: ToGeminiOptions,
): GeminiRequest {
  const { store } = opts;

  const contents: GeminiContent[] = [];
  const toolNamesById = new Map<string, string>();

  for (const msg of req.messages) {
    const parts = messageToParts(msg, store, toolNamesById);
    if (parts.length === 0) continue;
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  const out: GeminiRequest = { contents };

  const sys = systemText(req.system);
  if (sys) {
    out.systemInstruction = { parts: [{ text: sys }] };
  }

  if (req.tools?.length) {
    out.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: normalizeSchema(t.input_schema),
        })),
      },
    ];
    const tc = req.tool_choice;
    if (tc) {
      if (tc.type === "none") {
        out.toolConfig = { functionCallingConfig: { mode: "NONE" } };
      } else if (tc.type === "tool") {
        out.toolConfig = {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: [tc.name],
          },
        };
      } else {
        out.toolConfig = {
          functionCallingConfig: {
            mode: tc.type === "any" ? "ANY" : "AUTO",
          },
        };
      }
    }
  }

  const gen: NonNullable<GeminiRequest["generationConfig"]> = {
    candidateCount: 1,
  };
  if (req.max_tokens) gen.maxOutputTokens = req.max_tokens;
  if (req.temperature !== undefined) gen.temperature = req.temperature;
  if (req.top_p !== undefined) gen.topP = req.top_p;
  if (req.top_k !== undefined) gen.topK = req.top_k;
  if (req.stop_sequences?.length) gen.stopSequences = req.stop_sequences;

  const thinkingLevel = resolveThinkingLevel(req, opts.defaultThinkingLevel);
  if (thinkingLevel) {
    gen.thinkingConfig = { thinkingLevel };
  }
  out.generationConfig = gen;

  return out;
}

function messageToParts(
  msg: AnthropicMessage,
  store: SignatureStore,
  toolNamesById: Map<string, string>,
): GeminiPart[] {
  const blocks: AnthropicContentBlock[] =
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : msg.content;

  const parts: GeminiPart[] = [];
  let pendingSignature: string | undefined;

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        if (block.text) parts.push({ text: block.text });
        break;
      }

      case "thinking": {
        // Signature rides on the thinking block; it goes to the next
        // functionCall. If none follows, it is flushed at message end.
        if (block.signature) pendingSignature = block.signature;
        break;
      }

      case "redacted_thinking": {
        // Nothing to forward; signature is not recoverable.
        break;
      }

      case "tool_use": {
        toolNamesById.set(block.id, block.name);
        const sig = store.resolve(block.id, pendingSignature);
        pendingSignature = undefined;
        const part: GeminiPart = {
          functionCall: {
            id: block.id,
            name: block.name,
            args: block.input ?? {},
          },
        };
        if (sig) (part as { thoughtSignature?: string }).thoughtSignature = sig;
        parts.push(part);
        break;
      }

      case "tool_result": {
        parts.push({
          functionResponse: {
            id: block.tool_use_id,
            name: toolNamesById.get(block.tool_use_id) ?? block.tool_use_id,
            response: toolResultPayload(block.content, block.is_error),
          },
        });
        break;
      }
    }
  }

  if (pendingSignature) {
    parts.push({ thought: true, thoughtSignature: pendingSignature });
  }

  return parts;
}

function toolResultPayload(
  content: AnthropicContentBlock extends never ? never : unknown,
  is_error?: boolean,
): Record<string, unknown> {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) =>
        typeof b === "object" && b && "text" in b ? String(b.text) : "",
      )
      .join("");
  }
  const payload: Record<string, unknown> = {};
  if (text) {
    // Gemini's functionResponse.response must be an object.
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(payload, parsed);
      } else {
        payload.output = parsed;
      }
    } catch {
      payload.output = text;
    }
  }
  if (is_error) payload.is_error = true;
  return payload;
}

/**
 * Gemini's functionDeclarations parameters accept only a documented subset of
 * JSON Schema (per Google's structured output spec). Anything else —
 * propertyNames, exclusiveMinimum, $schema, ... — is an "Unknown name" 400.
 * Convert with an allowlist so future client tools can never break the
 * bridge: unknown fields are dropped, not discovered one 400 at a time.
 * (Same approach as @ai-sdk/google's sanitizeDefinition.)
 */
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "format",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "maximum",
  "minimum",
  "maxLength",
  "minLength",
  "pattern",
  "properties",
  "required",
  "items",
  "anyOf",
  "oneOf",
  "title",
]);

function normalizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (!node || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
      if (k === "properties") {
        // properties is a map of {propName: schema} — keys are property
        // names, not schema fields; only recurse into the values.
        const props = v as Record<string, unknown>;
        const propsOut: Record<string, unknown> = {};
        for (const [pk, pv] of Object.entries(props)) {
          const converted = convert(pv);
          if (converted !== undefined) propsOut[pk] = converted;
        }
        out.properties = propsOut;
        continue;
      }
      out[k] = convert(v);
    }
    // Preserve "const" semantics (converted, never passed raw).
    if ("const" in obj && obj.const !== undefined) {
      out.enum = [obj.const];
    }
    return out;
  };
  return convert(schema) as Record<string, unknown>;
}
