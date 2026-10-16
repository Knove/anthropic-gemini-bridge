// HTTP server: speaks Anthropic Messages on the front, calls the opencode
// Gemini generateContent gateway on the back.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  AnthropicMessageRequest,
  GeminiResponse,
} from "./types.ts";
import { toGeminiRequest, type ThinkingLevel } from "./to-gemini.ts";
import {
  AnthropicStreamAssembler,
  toAnthropicResponse,
} from "./to-anthropic.ts";
import { SignatureStore } from "./signature.ts";

const PORT = Number(process.env.BRIDGE_PORT ?? 8799);
const BASE_URL =
  process.env.BRIDGE_UPSTREAM ??
  "https://opencode.ai/inference/go/v1";
const API_KEY = process.env.OPENCODE_KEY ?? process.env.BRIDGE_API_KEY ?? "";
// Stable per-process session id; the gateway requires x-opencode-session.
const SESSION_ID = process.env.BRIDGE_SESSION_ID ?? randomUUID();

function parseThinkingEnv(raw: string | undefined): ThinkingLevel | "OFF" {
  const v = (raw ?? "HIGH").toUpperCase();
  if (v === "LOW" || v === "MEDIUM" || v === "HIGH" || v === "OFF") return v;
  return "HIGH";
}
const DEFAULT_THINKING_LEVEL = parseThinkingEnv(process.env.BRIDGE_THINKING_LEVEL);

const store = new SignatureStore();

if (!API_KEY) {
  console.error(
    "OPENCODE_KEY (or BRIDGE_API_KEY) is required. Export it from your env; it is never read from disk.",
  );
  process.exit(1);
}

function upstreamHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-goog-api-key": API_KEY,
    "x-opencode-session": SESSION_ID,
    accept: "application/json, text/event-stream",
  };
}

function geminiUrl(model: string, stream: boolean): string {
  const action = stream ? "streamGenerateContent" : "generateContent";
  const sep = stream ? "?alt=sse" : "";
  return `${BASE_URL}/models/${encodeURIComponent(model)}:${action}${sep}`;
}

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function anthropicError(
  res: import("node:http").ServerResponse,
  code: number,
  type: string,
  message: string,
): void {
  json(res, code, { type: "error", error: { type, message } });
}

async function readBody(
  req: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse upstream SSE (`data: {...}` lines) into JSON chunks. */
function parseSSE(
  text: string,
  onChunk: (obj: GeminiResponse) => void,
): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      onChunk(JSON.parse(payload) as GeminiResponse);
    } catch {
      // Ignore malformed keep-alive lines.
    }
  }
}

const DEBUG_SSE = process.env.BRIDGE_DEBUG_SSE === "1";

function writeSSE(
  res: import("node:http").ServerResponse,
  events: { event: string; data: unknown }[],
): void {
  for (const e of events) {
    if (DEBUG_SSE) {
      console.log(`[sse] ${e.event} ${JSON.stringify(e.data).slice(0, 160)}`);
    }
    res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  }
}

async function handleMessages(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  let body: AnthropicMessageRequest;
  try {
    body = JSON.parse(await readBody(req)) as AnthropicMessageRequest;
  } catch {
    anthropicError(res, 400, "invalid_request_error", "Invalid JSON body.");
    return;
  }

  if (!body?.messages?.length) {
    anthropicError(
      res,
      400,
      "invalid_request_error",
      "messages[] is required.",
    );
    return;
  }

  const t0 = Date.now();
  const upstreamModel = process.env.BRIDGE_MODEL ?? body.model;
  const stream = body.stream === true;
  const geminiReq = toGeminiRequest(body, {
    store,
    defaultThinkingLevel: DEFAULT_THINKING_LEVEL,
  });
  console.log(
    `[req] model=${body.model} stream=${stream} max_tokens=${body.max_tokens} thinking=${geminiReq.generationConfig?.thinkingConfig?.thinkingLevel ?? "OFF"} tools=${body.tools?.length ?? 0} msgs=${body.messages.length}`,
  );

  const url = geminiUrl(upstreamModel, stream);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify(geminiReq),
    });
  } catch (err) {
    anthropicError(
      res,
      502,
      "api_error",
      `Upstream unreachable: ${(err as Error).message}`,
    );
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    console.error(
      `[upstream ${upstream.status}] model=${upstreamModel} url=${url}`,
    );
    console.error(`[upstream ${upstream.status}] body: ${text.slice(0, 2000)}`);
    if (DEBUG_SSE) {
      // Full payload dumped to a timestamped file for offline replay/bisect.
      const dumpPath = `/tmp/bridge-fail-${Date.now()}.json`;
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(dumpPath, JSON.stringify(geminiReq, null, 2)),
      );
      console.error(`[upstream ${upstream.status}] payload dumped: ${dumpPath}`);
    }
    anthropicError(
      res,
      upstream.status,
      "api_error",
      `Upstream ${upstream.status}: ${text.slice(0, 800)}`,
    );
    return;
  }

  if (!stream) {
    const geminiResp = (await upstream.json()) as GeminiResponse;
    const out = toAnthropicResponse(geminiResp, body.model, { store });
    const u = geminiResp.usageMetadata;
    console.log(
      `[done] in=${u?.promptTokenCount ?? 0} out=${u?.candidatesTokenCount ?? 0} thoughts=${u?.thoughtsTokenCount ?? 0} ms=${Date.now() - t0}`,
    );
    json(res, 200, out);
    return;
  }

  // ---- streaming ----
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const assembler = new AnthropicStreamAssembler({
    model: body.model,
    store,
  });

  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage: GeminiResponse["usageMetadata"] | undefined;
  try {
    const reader = upstream.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(payload) as GeminiResponse;
        } catch {
          continue;
        }
        if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
        writeSSE(res, assembler.push(chunk));
      }
    }
    if (buffer.trim().startsWith("data:")) {
      const payload = buffer.trim().slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const chunk = JSON.parse(payload) as GeminiResponse;
          if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
          writeSSE(res, assembler.push(chunk));
        } catch {
          /* ignore */
        }
      }
    }
    writeSSE(res, assembler.finish());
    console.log(
      `[done] in=${lastUsage?.promptTokenCount ?? 0} out=${lastUsage?.candidatesTokenCount ?? 0} thoughts=${lastUsage?.thoughtsTokenCount ?? 0} ms=${Date.now() - t0}`,
    );
  } catch (err) {
    writeSSE(res, [
      {
        event: "error",
        data: {
          type: "error",
          error: {
            type: "api_error",
            message: `Stream aborted: ${(err as Error).message}`,
          },
        },
      },
    ]);
  } finally {
    res.end();
  }
}

function handleCountTokens(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): void {
  // Cheap approximation; Claude Code only uses this for progress display.
  void req;
  json(res, 200, { input_tokens: 0 });
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
    await handleMessages(req, res);
    return;
  }
  if (
    req.method === "POST" &&
    (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")
  ) {
    handleCountTokens(req, res);
    return;
  }
  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    json(res, 200, {
      data: [{ id: process.env.BRIDGE_MODEL ?? "bridge", type: "model" }],
    });
    return;
  }
  if (req.method === "GET" && path === "/health") {
    json(res, 200, { ok: true, upstream: BASE_URL });
    return;
  }
  anthropicError(res, 404, "not_found_error", `No route: ${req.method} ${path}`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[bridge] listening on http://127.0.0.1:${PORT} -> ${BASE_URL} (session ${SESSION_ID.slice(0, 8)}…)`,
  );
});
