# anthropic-gemini-bridge

A zero-dependency, lightweight protocol bridge that exposes **Gemini `generateContent` / `streamGenerateContent`** upstreams (such as the OpenCode Go gateway) as a standard **Anthropic Messages API (`/v1/messages` + SSE)** endpoint.

Built specifically so agentic clients like **Claude Code** can drive Gemini models seamlessly across multi-turn tool-use loops without hitting schema or signature validation errors.

---

## Architecture

```text
┌─────────────────────────┐       POST /v1/messages (Anthropic JSON / SSE)
│  Claude Code / SDK      │ ──────────────────────────────────────────────────┐
└─────────────────────────┘                                                   ▼
                                                             ┌──────────────────────────────────┐
                                                             │     anthropic-gemini-bridge      │
                                                             │  (127.0.0.1:8799, zero-dep TS)   │
                                                             │                                  │
                                                             │  1. Schema Allowlist Sanitizer   │
                                                             │  2. Thinking Level Mapper (HIGH) │
                                                             │  3. SignatureStore (tool_use_id) │
                                                             │  4. SSE Delta Stream Assembler   │
                                                             └──────────────────────────────────┘
┌─────────────────────────┐  POST /v1/models/{model}:(stream)GenerateContent  │
│  OpenCode Go / Gemini   │ ◀─────────────────────────────────────────────────┘
└─────────────────────────┘   + x-goog-api-key + x-opencode-session
```

## Why This Bridge Exists

Naive field-renaming proxies break immediately when Claude Code drives Gemini models in real agentic sessions. This bridge solves the **three hard protocol mismatches**:

### 1. `thought_signature` Round-Trip Preservation (Hard 400 on Tool Loops)
Gemini 2.5/3/4 thinking models attach a cryptographic `thoughtSignature` to `functionCall` parts and **reject subsequent tool-result turns with `400 INVALID_ARGUMENT` if the signature is missing**:
> `Function call is missing a thought_signature in functionCall parts.`

Anthropic's wire format places `signature` on separate `thinking` blocks rather than on `tool_use` blocks. The bridge preserves signatures across three layers:
- **Outbound (Gemini → Anthropic)**: Emits a preceding `thinking` block carrying `signature` (`signature_delta` in SSE) before `tool_use`, and indexes `(tool_use_id → thoughtSignature)` in `SignatureStore`.
- **Inbound (Anthropic → Gemini)**: Extracts `thinking.signature` and re-attaches it to the following `functionCall.thoughtSignature`.
- **Fallback Recovery**: If a client strips `thinking` blocks from history, `SignatureStore` automatically restores the signature by `tool_use.id`.
- **Clean Text Turns**: Trailing signatures on text-only turns are dropped (verified optional upstream) so no out-of-order trailing `thinking` block confuses Claude Code's output renderer.

### 2. JSON Schema Allowlist Sanitization (`const → enum`)
Claude Code sends 24+ built-in and MCP tool schemas containing OpenAPI / JSON Schema draft-07 keywords (`propertyNames`, `exclusiveMinimum`, `$schema`, `additionalProperties`, `const`) that Gemini's strict protobuf validator rejects with `400 Unknown name`.
- Instead of a fragile denylist, `to-gemini.ts` recursively filters schema nodes through the **documented Gemini Schema allowlist** (`GEMINI_SCHEMA_KEYS`) while preserving property names inside `properties` maps.
- Converts `{ const: x }` into `{ enum: [x] }` so literal constraints remain enforced.

### 3. Adaptive Thinking Depth Control (`thinkingConfig.thinkingLevel`)
Without an explicit `thinkingConfig`, `gemini-4-argon-contributor` defaults to `0` thinking tokens. The bridge automatically maps:
- Default: `thinkingConfig: { thinkingLevel: "HIGH" }` (configurable via `BRIDGE_THINKING_LEVEL`).
- Anthropic `output_config.effort`: `low → LOW`, `medium → MEDIUM`, `high | xhigh | max → HIGH`.
- Anthropic `thinking: { type: "disabled" }` → `LOW`.

---

## Requirements

- **Node.js `>= 22.6.0`** (runs `.ts` files natively with zero build step and zero `node_modules` dependencies).

---

## Quick Start

### 1. Clone & Configure

```bash
git clone <your-repo-url> anthropic-gemini-bridge
cd anthropic-gemini-bridge
cp .env.example .env
# Edit .env and set OPENCODE_KEY=your_key
```

### 2. Start the Bridge

```bash
# Via wrapper script (auto-loads .env)
./scripts/start.sh

# Or directly with Node
OPENCODE_KEY=your_key BRIDGE_MODEL=gemini-4-argon-contributor npm start
```

Verify health:

```bash
curl http://127.0.0.1:8799/health
# {"ok":true,"upstream":"https://opencode.ai/inference/go/v1"}
```

---

## Connecting Claude Code

### Option A: Wrapper Script (`--settings`, Recommended)

If your `~/.claude/settings.json` already contains an `env` block (e.g. pointing at another gateway), **shell environment variables like `ANTHROPIC_BASE_URL=... claude` are overridden by `settings.json`**. Passing `--settings` has the highest precedence:

```bash
./scripts/cc-gemini
# Or headless:
./scripts/cc-gemini --print "1+1=?"
```

### Option B: Direct `settings.json` Configuration

In `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8799",
    "ANTHROPIC_AUTH_TOKEN": "unused",
    "ANTHROPIC_MODEL": "gemini-4-argon-contributor[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-4-argon-contributor",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-4-argon-contributor",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-4-argon-contributor",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  },
  "model": "gemini-4-argon-contributor[1m]"
}
```

> Note: When `BRIDGE_MODEL` is set on the bridge, any `model` name sent by Claude Code is accepted and routed to `BRIDGE_MODEL` upstream.

---

## Running as a macOS Background Service (`launchd`)

1. Copy the template plist and replace `/ABSOLUTE/PATH/TO/anthropic-gemini-bridge` with your repository path:

```bash
cp examples/launchd/com.anthropic-gemini-bridge.plist ~/Library/LaunchAgents/
```

2. Load and manage the service:

```bash
# Start & enable on login
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.anthropic-gemini-bridge.plist

# Restart after config/code changes
launchctl kickstart -k gui/$(id -u)/com.anthropic-gemini-bridge

# Stop & unload
launchctl bootout gui/$(id -u)/com.anthropic-gemini-bridge
```

3. Inspect real-time request & thinking-token logs:

```bash
tail -f bridge.log
# [req] model=gemini-4-argon-contributor stream=true max_tokens=128000 thinking=HIGH tools=24 msgs=12
# [done] in=19420 out=312 thoughts=640 ms=5810
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_KEY` / `BRIDGE_API_KEY` | *(required)* | Upstream API key (sent in `x-goog-api-key`) |
| `BRIDGE_MODEL` | `req.model` (`gemini-4-argon-contributor` in `start.sh`) | Overrides the upstream Gemini model ID for all requests |
| `BRIDGE_PORT` | `8799` | Local HTTP port (bound to `127.0.0.1`) |
| `BRIDGE_THINKING_LEVEL` | `HIGH` | Default thinking depth: `HIGH` \| `MEDIUM` \| `LOW` \| `OFF` |
| `BRIDGE_UPSTREAM` | `https://opencode.ai/inference/go/v1` | Upstream Gemini `generateContent` base URL |
| `BRIDGE_SESSION_ID` | random UUID per process | Sent in `x-opencode-session` header |
| `BRIDGE_ENV_FILE` | `./.env` → `~/.claude/_/.env` | Custom path to `.env` file when using `scripts/start.sh` |
| `BRIDGE_DEBUG_SSE` | `0` | Set to `1` to log every SSE frame and dump failed upstream payloads to `/tmp/bridge-fail-*.json` |

---

## Programmatic Usage

All protocol converters are pure functions and exported from the package root:

```ts
import {
  SignatureStore,
  toGeminiRequest,
  toAnthropicResponse,
  AnthropicStreamAssembler,
} from "anthropic-gemini-bridge";

const store = new SignatureStore();
const geminiReq = toGeminiRequest(anthropicReq, {
  store,
  defaultThinkingLevel: "HIGH",
});
```

---

## Project Layout

```text
anthropic-gemini-bridge/
├── bin/
│   └── cli.js                  # CLI entry point (npx anthropic-gemini-bridge)
├── src/
│   ├── index.ts                # Public library exports
│   ├── types.ts                # Anthropic & Gemini wire format types
│   ├── signature.ts            # TTL-bounded SignatureStore (tool_use_id -> signature)
│   ├── to-gemini.ts            # Anthropic -> Gemini request, schema allowlist, thinkingConfig
│   ├── to-anthropic.ts         # Gemini -> Anthropic response & SSE stream assembler
│   └── server.ts               # Zero-dep HTTP server (/v1/messages, /v1/models, /health)
├── test/
│   ├── to-gemini.test.ts       # Request, schema allowlist, signature & thinking unit tests
│   └── to-anthropic.test.ts    # Response & SSE streaming unit tests
├── scripts/
│   ├── start.sh                # Portable service launcher (resolves Node & .env)
│   └── cc-gemini               # Claude Code launcher with --settings override
├── examples/
│   ├── claude-code/settings.json
│   └── launchd/com.anthropic-gemini-bridge.plist
├── .env.example
├── package.json
└── LICENSE
```

## Testing

```bash
npm test
```

## License

[MIT](./LICENSE)
