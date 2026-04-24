# copilot-openai-proxy

把 GitHub Copilot 包装成**标准 OpenAI 兼容接口**的本地代理服务。让 [OpenClaw](https://openclaw.ai) 等工具可以通过 `/v1/chat/completions` 直接调用 Copilot 订阅内的高端模型（GPT-5.4、Claude Sonnet 4.6 等）。

---

## 工作原理

```
你发消息
  → OpenClaw 路由到 copilot-proxy provider
    → HTTP POST http://127.0.0.1:3456/v1/chat/completions
      → copilot-proxy/index.mjs 处理
        → @github/copilot-sdk（stdio 调用 Copilot CLI）
          → GitHub Copilot 后端
            → 流式响应返回
```

代理负责处理：Session 生命周期、流式输出、工具调用、图片附件、请求指标统计 —— 全部翻译为 OpenAI 格式。

---

## 前提条件

1. **GitHub Copilot CLI** 已安装（`/opt/homebrew/bin/copilot` 或在 `$PATH` 中）
2. **已登录 GitHub** 并激活 Copilot 订阅
3. **Node.js** v18+（已在 v20/v25 验证）

---

## 安装

```bash
cd ~/.openclaw/workspace/skills/copilot-openai-proxy
npm install
```

---

## 启动代理

### 方式一：launchd 常驻（macOS，推荐）

`daemon/` 目录下提供了 launchd 脚本模板，注册后开机自启：

```bash
# 加载服务
launchctl load ~/Library/LaunchAgents/ai.openclaw.copilot-openai-proxy.plist

# 查看状态
launchctl print gui/$(id -u)/ai.openclaw.copilot-openai-proxy | head -20

# 重启服务
launchctl kickstart -k gui/$(id -u)/ai.openclaw.copilot-openai-proxy
```

日志位置：

```
~/.openclaw/logs/copilot-openai-proxy.stdout.log
~/.openclaw/logs/copilot-openai-proxy.stderr.log
```

### 方式二：手动前台运行

```bash
node ./copilot-proxy/index.mjs \
  --host 127.0.0.1 \
  --port 3456 \
  --default-model claude-sonnet-4.6
```

可用参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--host` | `127.0.0.1` | 监听地址 |
| `--port` | `3456` | 监听端口 |
| `--default-model` | `claude-sonnet-4.6` | 未指定模型时的默认模型 |
| `--session-ttl-ms` | `1800000` | Session 空闲超时（ms） |
| `--send-timeout-ms` | `1800000` | 单次发送最大等待时间（ms） |
| `--turn-event-timeout-ms` | `180000` | Turn 事件静默超时（ms） |
| `--cwd` | 当前目录 | 传给 Copilot 的工作目录 |

---

## 验证是否正常

```bash
# 健康检查
curl http://127.0.0.1:3456/health

# 查看可用模型
curl http://127.0.0.1:3456/v1/models | jq .

# 简单对话测试
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"你好"}]}'
```

---

## 接入 OpenClaw

在 `openclaw.json` 中添加 provider：

```json
{
  "models": {
    "providers": {
      "copilot-proxy": {
        "type": "openai-compat",
        "baseUrl": "http://127.0.0.1:3456/v1",
        "apiKey": "none",
        "models": {
          "gpt-5.4":           { "label": "GPT-5.4 (Copilot)" },
          "gpt-5.4-mini":      { "label": "GPT-5.4 Mini (Copilot)" },
          "claude-sonnet-4.6": { "label": "Claude Sonnet 4.6 (Copilot)" }
        }
      }
    }
  }
}
```

然后在 OpenClaw 里切换模型：

```
/model copilot-proxy/gpt-5.4
/model copilot-proxy/claude-sonnet-4.6
```

---

## 文件结构

| 路径 | 说明 |
|------|------|
| `copilot-proxy/index.mjs` | HTTP server + 请求路由 |
| `copilot-proxy/config.mjs` | CLI 参数解析 + 默认值 |
| `copilot-proxy/session.mjs` | Session 生命周期管理 |
| `copilot-proxy/messages.mjs` | OpenAI → Copilot 消息格式转换 |
| `copilot-proxy/tools.mjs` | Tool call 序列化/反序列化 |
| `copilot-proxy/image.mjs` | 图片附件处理 |
| `copilot-proxy/timeout.mjs` | 超时控制 + 看门狗 |
| `copilot-proxy/events.mjs` | Turn 事件队列 |
| `copilot-proxy/logger.mjs` | 结构化 JSON 日志（`LOG_LEVEL` 控制粒度） |
| `copilot-proxy/errors.mjs` | 统一错误响应构建 |
| `copilot-proxy/db.mjs` | SQLite 请求日志（`~/.openclaw/logs/copilot-proxy.db`） |
| `copilot-proxy/metrics.mjs` | 请求计数/延迟统计，供 `/metrics` 端点使用 |
| `daemon/start.sh` | 启动脚本模板（复制到 `~/.openclaw/bin/`） |
| `daemon/watch.sh` | 健康监控脚本模板 |
| `daemon/healthcheck.sh` | 单次健康检查脚本 |

---

## 常见问题

**`Cannot find module '@github/copilot-sdk'`**
依赖未安装，重新执行 `npm install`。

**`/health` 连接拒绝**
代理没在运行，手动启动或检查 launchd plist 是否正确加载。

**切换模型后请求超时**
Copilot CLI session 可能已过期，重新执行 CLI 二进制文件以重新认证。

**重启后服务没起来**
检查 plist 是否已加载：`launchctl list | grep copilot`，没有则重新 `launchctl load`。

---

## 技术说明

- **Token 计费**：Copilot 按请求计费，不按 token。代理在 usage 字段返回 `0`，实际计数通过 `debug` 日志输出。
- **Session 复用**：Copilot session 是有状态的。代理维护一个 session 池，按模型 + 对话上下文 keyed，支持 TTL 配置。
- **流式输出**：所有响应通过 SSE (`text/event-stream`) 流式传输，代理将 Copilot 事件翻译为 OpenAI delta 格式。
- **工具调用**：支持并行 tool call，结果批量注入为 `tool` role 消息。
- **图片支持**：`content` 数组中的 base64 图片会转发给支持视觉的 Copilot 模型。

---

## License

MIT
