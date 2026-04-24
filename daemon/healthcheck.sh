#!/usr/bin/env bash
set -euo pipefail
URL="http://127.0.0.1:3456/health"
STATE_DIR="$HOME/.openclaw/run"
FAIL_FILE="$STATE_DIR/copilot-openai-proxy.fail"
STAMP_FILE="$STATE_DIR/copilot-openai-proxy.last_ok"
mkdir -p "$STATE_DIR"
if curl -fsS --max-time 10 "$URL" >/dev/null; then
  date '+%F %T %z' > "$STAMP_FILE"
  rm -f "$FAIL_FILE"
  exit 0
fi
NOW=$(date +%s)
LAST=0
if [ -f "$FAIL_FILE" ]; then
  LAST=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
fi
if [ "$LAST" = "0" ]; then
  echo "$NOW" > "$FAIL_FILE"
fi
exit 1
