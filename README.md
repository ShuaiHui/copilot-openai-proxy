# copilot-openai-proxy

A lightweight local proxy that wraps GitHub Copilot as an **OpenAI-compatible HTTP API**, so tools like [OpenClaw](https://openclaw.ai) can use Copilot-backed models (GPT-5.4, Claude Sonnet 4.6, etc.) via standard `/v1/chat/completions` calls.

---

## How It Works

```
Your request
  → OpenClaw routes to copilot-proxy provider
    → HTTP POST to http://127.0.0.1:3456/v1/chat/completions
      → copilot-proxy/index.mjs
        → @github/copilot-sdk (stdio to Copilot CLI)
          → GitHub Copilot backend
            → streamed response
```

The proxy handles session lifecycle, streaming, tool calls, image attachments, and request metrics — all translated to/from the OpenAI wire format.

---

## Prerequisites

1. **GitHub Copilot CLI** installed at `/opt/homebrew/bin/copilot` (or on `$PATH`)
2. **Logged in** to GitHub with an active Copilot subscription
3. **Node.js** v18+ (tested on v20/v25)

---

## Installation

```bash
cd ~/.openclaw/workspace/skills/copilot-openai-proxy
npm install
```

---

## Starting the Proxy

### Option A: launchd daemon (macOS, recommended)

The included daemon scripts can be registered with launchd for auto-start on login.

```bash
# Load the service
launchctl load ~/Library/LaunchAgents/ai.openclaw.copilot-openai-proxy.plist

# Check status
launchctl print gui/$(id -u)/ai.openclaw.copilot-openai-proxy | head -20

# Restart
launchctl kickstart -k gui/$(id -u)/ai.openclaw.copilot-openai-proxy
```

Logs are written to:
```
~/.openclaw/logs/copilot-openai-proxy.stdout.log
~/.openclaw/logs/copilot-openai-proxy.stderr.log
```

### Option B: Manual / foreground

```bash
node ./copilot-proxy/index.mjs \
  --host 127.0.0.1 \
  --port 3456 \
  --default-model claude-sonnet-4.6
```

Available CLI flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `3456` | Listen port |
| `--default-model` | `claude-sonnet-4.6` | Model used when none is specified |
| `--session-ttl-ms` | `1800000` | Idle session expiry (ms) |
| `--send-timeout-ms` | `1800000` | Max time per send (ms) |
| `--turn-event-timeout-ms` | `180000` | Turn event silence timeout (ms) |
| `--cwd` | process cwd | Working directory passed to Copilot |

---

## Verifying It Works

```bash
# Health check
curl http://127.0.0.1:3456/health

# List available models
curl http://127.0.0.1:3456/v1/models | jq .

# Quick chat test
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"hello"}]}'
```

---

## Integrating with OpenClaw

Add the provider to your `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "copilot-proxy": {
        "type": "openai-compat",
        "baseUrl": "http://127.0.0.1:3456/v1",
        "apiKey": "none",
        "models": {
          "gpt-5.4":          { "label": "GPT-5.4 (Copilot)" },
          "gpt-5.4-mini":     { "label": "GPT-5.4 Mini (Copilot)" },
          "claude-sonnet-4.6":{ "label": "Claude Sonnet 4.6 (Copilot)" }
        }
      }
    }
  }
}
```

Then switch models in OpenClaw:

```
/model copilot-proxy/gpt-5.4
/model copilot-proxy/claude-sonnet-4.6
```

---

## File Structure

| Path | Description |
|------|-------------|
| `copilot-proxy/index.mjs` | HTTP server + request router |
| `copilot-proxy/config.mjs` | CLI argument parsing + defaults |
| `copilot-proxy/session.mjs` | Session lifecycle (create/reuse/expire) |
| `copilot-proxy/messages.mjs` | OpenAI → Copilot message conversion |
| `copilot-proxy/tools.mjs` | Tool call serialization/deserialization |
| `copilot-proxy/image.mjs` | Image attachment handling |
| `copilot-proxy/timeout.mjs` | Per-turn timeout + watchdog |
| `copilot-proxy/events.mjs` | Turn event queue |
| `copilot-proxy/logger.mjs` | Structured JSON logger (`LOG_LEVEL` env) |
| `copilot-proxy/errors.mjs` | Standardized error response builders |
| `copilot-proxy/db.mjs` | SQLite request log (`~/.openclaw/logs/copilot-proxy.db`) |
| `copilot-proxy/metrics.mjs` | In-memory request counters + `/metrics` endpoint |
| `daemon/start.sh` | Startup script template (copy to `~/.openclaw/bin/`) |
| `daemon/watch.sh` | Health-watcher script template |
| `daemon/healthcheck.sh` | One-shot health check script |

---

## Troubleshooting

**`Cannot find module '@github/copilot-sdk'`**
Run `npm install` in the project root.

**`/health` returns connection refused**
The proxy is not running. Start it manually or check your launchd plist.

**Requests time out after model switch**
The Copilot CLI session may have expired. Re-run the CLI binary to re-authenticate.

**Service doesn't start after reboot**
Check that the plist is loaded: `launchctl list | grep copilot`. If missing, reload with `launchctl load`.

---

## Technical Notes

- **Token counting**: Copilot is billed per-request, not per-token. The proxy returns `prompt_tokens: 0 / completion_tokens: 0` in usage fields; actual counts are emitted as `debug` logs.
- **Session reuse**: Copilot sessions are stateful. The proxy maintains a session pool keyed by model + conversation context, with configurable TTL.
- **Streaming**: All responses are streamed via SSE (`text/event-stream`), with the proxy performing event → OpenAI delta translation.
- **Tool calls**: Parallel tool calls are supported. Results are batched and injected as `tool` role messages.
- **Image support**: Base64-encoded images in `content` arrays are forwarded to Copilot's vision-capable models.

---

## License

MIT
