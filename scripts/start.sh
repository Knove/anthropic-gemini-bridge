#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Ensure node >= 22.6 is on PATH (important when launched via macOS launchd).
if ! command -v node >/dev/null 2>&1; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -n 1 || true)"
  if [ -n "$NVM_BIN" ]; then
    export PATH="$NVM_BIN:$PATH"
  fi
fi

# Load API key from the first available env file without echoing secrets.
for env_file in "${BRIDGE_ENV_FILE:-}" "$ROOT_DIR/.env" "$HOME/.claude/_/.env"; do
  if [ -n "$env_file" ] && [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    break
  fi
done

export BRIDGE_MODEL="${BRIDGE_MODEL:-gemini-4-argon-contributor}"
export BRIDGE_PORT="${BRIDGE_PORT:-8799}"
export BRIDGE_THINKING_LEVEL="${BRIDGE_THINKING_LEVEL:-HIGH}"

exec node "$ROOT_DIR/src/server.ts"
