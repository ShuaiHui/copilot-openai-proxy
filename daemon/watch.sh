#!/usr/bin/env bash
set -euo pipefail
URL="http://127.0.0.1:3456/health"
STATE_DIR="/Users/shuaihui/.openclaw/run"
ALERT_FILE="$STATE_DIR/copilot-openai-proxy.alerted"
mkdir -p "$STATE_DIR"
if curl -fsS --max-time 10 "$URL" >/dev/null; then
  if [ -f "$ALERT_FILE" ]; then
    /opt/homebrew/bin/openclaw cron wake --mode now "✅ copilot-openai-proxy 已恢复正常，127.0.0.1:3456 健康检查通过。"
  fi
  rm -f "$ALERT_FILE"
  exit 0
fi
NOW=$(date '+%F %T %z')
if [ ! -f "$ALERT_FILE" ]; then
  echo "$NOW" > "$ALERT_FILE"
  /opt/homebrew/bin/openclaw cron wake --mode now "提醒：copilot-openai-proxy 当前健康检查失败，127.0.0.1:3456 无响应。请检查 launchd 服务 ai.openclaw.copilot-openai-proxy 与日志 /Users/shuaihui/.openclaw/logs/copilot-openai-proxy.stderr.log。这是一条故障提醒。"
fi
exit 1
