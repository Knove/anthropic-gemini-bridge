import { test } from "node:test";
import assert from "node:assert/strict";
import { toGeminiRequest } from "../src/to-gemini.ts";
import { SignatureStore } from "../src/signature.ts";

test("text message maps to a user content", () => {
  const store = new SignatureStore();
  const out = toGeminiRequest(
    {
      model: "m",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    },
    { store },
  );
  assert.equal(out.contents.length, 1);
  assert.equal(out.contents[0].role, "user");
  assert.deepEqual(out.contents[0].parts, [{ text: "hi" }]);
  assert.equal(out.generationConfig?.maxOutputTokens, 100);
});

test("system string maps to systemInstruction", () => {
  const store = new SignatureStore();
  const out = toGeminiRequest(
    {
      model: "m",
      max_tokens: 10,
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
    },
    { store },
  );
  assert.deepEqual(out.systemInstruction?.parts, [{ text: "be brief" }]);
});

test("tool_use becomes functionCall and tool_result becomes functionResponse", () => {
  const store = new SignatureStore();
  const out = toGeminiRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "get_weather",
              input: { city: "Beijing" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: '{"temperature":22}',
            },
          ],
        },
      ],
    },
    { store },
  );
  assert.equal(out.contents.length, 2);
  const call = out.contents[0].parts[0] as {
    functionCall: { name: string; args: Record<string, unknown> };
  };
  assert.equal(call.functionCall.name, "get_weather");
  assert.deepEqual(call.functionCall.args, { city: "Beijing" });

  const resp = out.contents[1].parts[0] as {
    functionResponse: { name: string; response: Record<string, unknown> };
  };
  assert.equal(resp.functionResponse.name, "get_weather");
  assert.deepEqual(resp.functionResponse.response, { temperature: 22 });
});

test("thinking signature attaches to the following functionCall part", () => {
  const store = new SignatureStore();
  const out = toGeminiRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "SIG_A" },
            {
              type: "tool_use",
              id: "call_1",
              name: "t",
              input: {},
            },
          ],
        },
      ],
    },
    { store },
  );
  const part = out.contents[0].parts[0] as { thoughtSignature?: string };
  assert.equal(part.thoughtSignature, "SIG_A");
});

test("missing signature is recovered from the cache by tool_use id", () => {
  const store = new SignatureStore();
  store.put("call_1", "SIG_CACHED");

  const out = toGeminiRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            // Client dropped the thinking block entirely.
            { type: "tool_use", id: "call_1", name: "t", input: {} },
          ],
        },
      ],
    },
    { store },
  );
  const part = out.contents[0].parts[0] as { thoughtSignature?: string };
  assert.equal(part.thoughtSignature, "SIG_CACHED");
});

test("orphan signature flushes as a standalone thought part", () => {
  const store = new SignatureStore();
  const out = toGeminiRequest(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "SIG_ORPHAN" },
            { type: "text", text: "hello" },
          ],
        },
      ],
    },
    { store },
  );
  const parts = out.contents[0].parts as Record<string, unknown>[];
  const thought = parts.find((p) => p.thought === true);
  assert.ok(thought, "expected a standalone thought part");
  assert.equal(thought.thoughtSignature, "SIG_ORPHAN");
});

test("tools map to functionDeclarations with normalized schema", () => {
  const store = new SignatureStore();
  const out = toGeminiRequest(
    {
      model: "m",
      max_tokens: 10,
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
            $schema: "http://json-schema.org/draft-07/schema#",
          },
        },
      ],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "hi" }],
    },
    { store },
  );
  const decl = out.tools?.[0]?.functionDeclarations?.[0];
  assert.equal(decl?.name, "get_weather");
  assert.equal(decl?.parameters?.additionalProperties, undefined);
  assert.equal(decl?.parameters?.$schema, undefined);
  assert.equal(out.toolConfig?.functionCallingConfig.mode, "AUTO");
});

test("schema allowlist drops unknown fields without touching known ones", () => {
  const store = new SignatureStore();
  const out = toGeminiRequest(
    {
      model: "m",
      max_tokens: 10,
      tools: [
        {
          name: "t",
          input_schema: {
            type: "object",
            properties: {
              a: { type: "string", minLength: 1, pattern: "^x" },
              b: { type: "number", minimum: 0, exclusiveMinimum: 0 },
              c: { const: "fixed" },
            },
            // 每一个都是 Gemini 会 400 的字段，白名单应全丢
            propertyNames: { type: "string" },
            $schema: "http://x",
            additionalProperties: false,
            default: {},
            examples: [],
          },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    },
    { store },
  );
  const p = out.tools?.[0]?.functionDeclarations?.[0]?.parameters as Record<
    string,
    unknown
  >;
  // 已知字段保留
  assert.equal(p.type, "object");
  const props = p.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.a.minLength, 1);
  assert.equal(props.a.pattern, "^x");
  assert.equal(props.b.minimum, 0);
  // 未知字段丢弃
  assert.equal(p.propertyNames, undefined);
  assert.equal(p.$schema, undefined);
  assert.equal(p.additionalProperties, undefined);
  assert.equal(p.default, undefined);
  assert.equal(p.examples, undefined);
  assert.equal(props.b.exclusiveMinimum, undefined);
  // const → enum 语义保真
  assert.deepEqual(props.c.enum, ["fixed"]);
});

test("thinkingLevel defaults to HIGH and maps output_config.effort / thinking.type", () => {
  const store = new SignatureStore();
  const base = {
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user" as const, content: "hi" }],
  };

  assert.equal(
    toGeminiRequest(base, { store }).generationConfig?.thinkingConfig
      ?.thinkingLevel,
    "HIGH",
  );
  assert.equal(
    toGeminiRequest(
      { ...base, output_config: { effort: "low" } },
      { store },
    ).generationConfig?.thinkingConfig?.thinkingLevel,
    "LOW",
  );
  assert.equal(
    toGeminiRequest(
      { ...base, output_config: { effort: "medium" } },
      { store },
    ).generationConfig?.thinkingConfig?.thinkingLevel,
    "MEDIUM",
  );
  assert.equal(
    toGeminiRequest(
      { ...base, output_config: { effort: "max" } },
      { store },
    ).generationConfig?.thinkingConfig?.thinkingLevel,
    "HIGH",
  );
  assert.equal(
    toGeminiRequest(
      { ...base, thinking: { type: "disabled" }, output_config: { effort: "max" } },
      { store },
    ).generationConfig?.thinkingConfig?.thinkingLevel,
    "LOW",
  );
  assert.equal(
    toGeminiRequest(base, { store, defaultThinkingLevel: "OFF" })
      .generationConfig?.thinkingConfig,
    undefined,
  );
});

