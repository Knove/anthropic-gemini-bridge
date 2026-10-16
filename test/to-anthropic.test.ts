import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicStreamAssembler,
  attachSignature,
  toAnthropicResponse,
} from "../src/to-anthropic.ts";
import { SignatureStore } from "../src/signature.ts";

let n = 0;
const idGen = () => `msg_${++n}`;

test("text part becomes a text block", () => {
  const out = toAnthropicResponse(
    {
      candidates: [
        { content: { role: "model", parts: [{ text: "Pong!" }] }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
    },
    "gemini-x",
    { idGen },
  );
  assert.equal(out.content.length, 1);
  assert.deepEqual(out.content[0], { type: "text", text: "Pong!" });
  assert.equal(out.stop_reason, "end_turn");
  assert.equal(out.usage.input_tokens, 10);
  assert.equal(out.usage.output_tokens, 3);
});

test("thoughtSignature on a text part is dropped (text turns don't need it)", () => {
  const out = toAnthropicResponse(
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Pong!", thoughtSignature: "SIG_T" }],
          },
          finishReason: "STOP",
        },
      ],
    },
    "gemini-x",
    { idGen },
  );
  // Text-part signatures are not round-trip-required; only text remains.
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, "text");
});

test("functionCall becomes tool_use with stop_reason tool_use and caches the signature", () => {
  const store = new SignatureStore();
  const out = toAnthropicResponse(
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                thoughtSignature: "SIG_F",
                functionCall: {
                  id: "call_9",
                  name: "get_weather",
                  args: { city: "Beijing" },
                },
              },
            ],
          },
          finishReason: "STOP",
          finishMessage: "Model generated function call(s).",
        },
      ],
    },
    "gemini-x",
    { store, idGen },
  );
  assert.equal(out.stop_reason, "tool_use");
  const toolUse = out.content.find((b) => b.type === "tool_use") as {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
  assert.equal(toolUse.name, "get_weather");
  assert.deepEqual(toolUse.input, { city: "Beijing" });
  assert.equal(store.resolve(toolUse.id), "SIG_F");
});

test("attachSignature stamps the trailing thinking block (JD semantics)", () => {
  // Last block is thinking -> signature goes onto it, nothing appended.
  const blocks: Parameters<typeof attachSignature>[0] = [
    { type: "text", text: "hi" },
    { type: "thinking", thinking: "hmm", signature: "" },
  ];
  attachSignature(blocks, "SIG_REUSE");
  assert.equal(blocks.length, 2);
  assert.equal((blocks[1] as { signature: string }).signature, "SIG_REUSE");
});

test("attachSignature appends when a non-thinking block is in between", () => {
  // Walk-back stops at the text block, so a fresh thinking block is appended.
  const blocks: Parameters<typeof attachSignature>[0] = [
    { type: "thinking", thinking: "hmm", signature: "" },
    { type: "text", text: "hi" },
  ];
  attachSignature(blocks, "SIG_NEW");
  assert.equal(blocks.length, 3);
  const last = blocks[2] as { type: string; signature: string };
  assert.equal(last.type, "thinking");
  assert.equal(last.signature, "SIG_NEW");
  // Pre-existing thinking block is left untouched.
  assert.equal((blocks[0] as { signature: string }).signature, "");
});

test("stream: text chunks emit message_start / deltas / message_stop in order", () => {
  const asm = new AnthropicStreamAssembler({
    model: "gemini-x",
    idGen: () => `msg_s${++n}`,
  });

  const e1 = asm.push({
    candidates: [
      { content: { role: "model", parts: [{ text: "1, 2" }] } },
    ],
    usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4 },
  });
  const e2 = asm.push({
    candidates: [
      { content: { role: "model", parts: [{ text: ", 3." }] } },
    ],
    usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 8 },
  });
  const e3 = asm.push({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "", thoughtSignature: "SIG_S" }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 9 },
  });
  const tail = asm.finish();

  const events = [...e1, ...e2, ...e3, ...tail].map((e) => e.event);
  // Consecutive text chunks merge into one content block; the trailing
  // text-part signature is dropped (not round-trip-required).
  assert.deepEqual(events, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);

  const sigEvent = [...e3, ...tail].find(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data as { delta?: { type?: string } }).delta?.type === "signature_delta",
  );
  assert.equal(sigEvent, undefined, "no signature_delta for text-only turns");
});

test("stream: tool call emits thinking block first, then tool_use with input_json_delta", () => {
  const store = new SignatureStore();
  const asm = new AnthropicStreamAssembler({
    model: "gemini-x",
    store,
    idGen: () => `msg_t${++n}`,
  });

  const ev = [
    ...asm.push({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                thoughtSignature: "SIG_TOOL",
                functionCall: {
                  id: "call_7",
                  name: "get_weather",
                  args: { city: "Beijing" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    }),
    ...asm.finish(),
  ];

  const starts = ev.filter((e) => e.event === "content_block_start");
  assert.equal(starts.length, 2);
  assert.equal(
    (starts[0].data as { content_block: { type: string } }).content_block.type,
    "thinking",
  );
  assert.equal(
    (starts[1].data as { content_block: { type: string } }).content_block.type,
    "tool_use",
  );

  const inputDelta = ev.find(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data as { delta: { type: string } }).delta.type === "input_json_delta",
  );
  assert.ok(inputDelta);
  assert.equal(
    JSON.parse(
      (inputDelta.data as { delta: { partial_json: string } }).delta.partial_json,
    ).city,
    "Beijing",
  );

  const last = ev[ev.length - 2] as { data: { delta: { stop_reason: string } } };
  assert.equal(last.data.delta.stop_reason, "tool_use");
});

test("stream: multi-turn signature round-trip via cache", () => {
  const store = new SignatureStore();
  const asm = new AnthropicStreamAssembler({
    model: "gemini-x",
    store,
    idGen: () => `msg_r${++n}`,
  });
  for (const e of [
    ...asm.push({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                thoughtSignature: "SIG_RT",
                functionCall: { id: "call_rt", name: "t", args: { a: 1 } },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    }),
    ...asm.finish(),
  ]) {
    void e;
  }
  assert.equal(store.resolve("call_rt"), "SIG_RT");
});
