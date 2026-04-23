#!/usr/bin/env bash
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_DIR"
exec /opt/homebrew/bin/node "$SKILL_DIR/copilot-proxy/index.mjs" \
  --host 127.0.0.1 \
  --port 3456 \
  --default-model claude-sonnet-4.6 \
  --cwd /Users/shuaihui/.openclaw/workspace \
  --session-ttl-ms 1800000 \
  --send-timeout-ms 1800000 \
  --turn-event-timeout-ms 180000
