---
name: copilot-openai-proxy
description: 通过 GitHub Copilot SDK 启动本地 OpenAI 兼容代理，并接入 OpenClaw 的 cli-proxy provider。适用于把 Copilot 模型当成 OpenAI-compatible 后端使用。
---

# Copilot OpenAI Proxy

## 1. 目标

这个技能用于维护下面这条链路：

```text
OpenClaw → providers.cli-proxy → /v1/chat/completions → copilot-openai-proxy.mjs → GitHub Copilot CLI / SDK
```

它解决两个问题：

1. 把 GitHub Copilot 暴露成 **OpenAI 兼容接口**
2. 让 OpenClaw 通过**独立 provider**（推荐 `copilot-proxy/<model-id>`）使用 Copilot 模型，避免污染原有 `cli-proxy`

---

## 2. 关键文件

### 2.1 代理入口（模块化）

```text
/Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy/copilot-proxy/index.mjs
```

模块目录：
```
copilot-proxy/
├── index.mjs     # 入口 + HTTP server + silent-retry 逻辑
├── config.mjs    # DEFAULTS + parseArgs
├── events.mjs    # logProxyEvent + turn 事件队列
├── messages.mjs  # 消息解析 + prompt 构建
├── image.mjs     # 图片附件处理
├── tools.mjs     # tool call 处理
├── timeout.mjs   # sendWithActivityTimeout + shutdown metrics
├── session.mjs   # buildClient + makeSessionConfig + buildResponse
└── metrics.mjs   # 请求计数 / 延迟 / token 统计，供 /metrics 端点使用
```

旧单文件（备份，可删）：
```text
/Users/shuaihui/.openclaw/scripts/copilot-openai-proxy.mjs
```

### 2.2 OpenClaw 主配置

```text
/Users/shuaihui/.openclaw/openclaw.json
```

### 2.3 本技能文档

```text
/Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy/SKILL.md
```

---

## 3. 依赖

### 3.1 必需 npm 包

```bash
cd /Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy
npm install @github/copilot-sdk@0.2.2
```

> ⚠️ node_modules 现在放在 skills 目录本身，不再是 `scripts/`。start.sh 通过 `cd "$SKILL_DIR"` 确保 ESM 解析路径正确。

### 3.2 关键结论

不要把 SDK 当成 `@github/copilot` 的子路径来引用。

**错误写法：**

```js
import { CopilotClient, approveAll } from '@github/copilot/sdk'
```

**正确写法：**

```js
import { CopilotClient, approveAll } from '@github/copilot-sdk'
```

这是这套代理恢复可用的核心点。

---

## 4. 启动方式

### 4.1 手动启动

```bash
node /Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy/copilot-proxy/index.mjs --host 127.0.0.1 --port 3456
```

### 4.2 推荐常驻方式（launchd）

生产环境不要再用临时 `exec` / `nohup` 孤儿进程常驻。

当前稳定方案：

- LaunchAgent：`~/Library/LaunchAgents/ai.openclaw.copilot-openai-proxy.plist`
- 启动脚本：`/Users/shuaihui/.openclaw/bin/start-copilot-openai-proxy.sh`（指向 skills 目录入口）
- stdout：`/Users/shuaihui/.openclaw/logs/copilot-openai-proxy.stdout.log`
- stderr：`/Users/shuaihui/.openclaw/logs/copilot-openai-proxy.stderr.log`

常用命令：

```bash
launchctl print gui/$(id -u)/ai.openclaw.copilot-openai-proxy | sed -n '1,120p'
launchctl kickstart -k gui/$(id -u)/ai.openclaw.copilot-openai-proxy
```

### 4.3 watcher / 故障提醒

当前还配了一层 watcher：

- LaunchAgent：`~/Library/LaunchAgents/ai.openclaw.copilot-openai-proxy.watch.plist`
- 检查脚本：`/Users/shuaihui/.openclaw/bin/copilot-openai-proxy-watch.sh`
- daemon 源脚本：`skills/copilot-openai-proxy/daemon/`（start.sh / watch.sh / healthcheck.sh）

职责：

1. 每 60 秒检查一次 `http://127.0.0.1:3456/health`
2. 首次失败时发一条 OpenClaw wake 提醒
3. 恢复后清理告警锁文件，避免重复轰炸

### 4.4 常用参数

```bash
--host 127.0.0.1
--port 3456
--default-model claude-sonnet-4.6   # 默认值；可改为 gpt-5.4 等
--cwd /Users/shuaihui/.openclaw/workspace
--session-ttl-ms 1800000             # 默认 30 分钟
--send-timeout-ms 1800000            # 默认 6 分钟（DEFAULTS）；start.sh 设 30 分钟
--turn-event-timeout-ms 180000       # 默认 180 秒；工具执行中有心跳推送，可适当调大
```

**内置超时常量（不可通过 CLI 覆盖）：**

| 常量 | 值 | 说明 |
|---|---|---|
| `turnEventTimeoutMs` | 180 s | turn 事件超时；工具执行时心跳刷新，长任务不易误触 |
| `timeoutFallbackModel` | `gpt-5.4` | 超时恢复时自动切换到此模型 |

---

## 5. 代理接口

### 5.1 健康检查

```http
GET /health
```

### 5.2 模型列表

```http
GET /v1/models
```

### 5.3 对话补全

```http
POST /v1/chat/completions
```

**可选 Session 控制（Header 或 Body 字段二选一）：**

| Header | Body 字段 | 说明 |
|---|---|---|
| `x-copilot-session-key` | `session_key` | 复用已有 Copilot 会话，跨请求保持上下文 |
| `x-copilot-new-session: 1` | `new_session: true` | 强制关闭旧会话并新建（对应 OpenClaw `/new`） |

**ask_user pending 回复机制：**

当 Copilot session 正在等待 `ask_user` 工具回复时，下一个携带相同 `session_key` 的 `POST /v1/chat/completions` 会被当作用户对 `ask_user` 的回复处理，而不是新的请求发送。

### 5.4 运维指标

```http
GET /metrics
```

返回 JSON，字段：

| 字段 | 说明 |
|---|---|
| `uptimeMs` | 服务启动后运行时间 |
| `sessions.active` | 当前活跃 session 数 |
| `requestsTotal` | 累计请求数 |
| `requestsCompleted` | 正常完成数 |
| `requestsTimeout` | 超时次数 |
| `requestsError` | 5xx 错误次数 |
| `models.<id>.avgLatencyMs` | 该模型平均响应时间（ms） |


### 5.5 调试接口

```http
GET    /debug/sessions
POST   /debug/sessions/:key/close
DELETE /debug/sessions/:key
```

---

## 6. 当前接入的模型

### 6.1 已注册到 OpenClaw（agents.defaults.models）

| OpenClaw 模型 ID | 底层模型 | ctx | 费率倍数 | 说明 |
|---|---|---|---|---|
| `copilot-proxy/gpt-5.4` | `gpt-5.4` | 400k | 1× | 主力模型 |
| `copilot-proxy/gpt-5.4-mini` | `gpt-5.4-mini` | 400k | 0.33× | 轻量快速 |
| `copilot-proxy/claude-sonnet-4.6` | `claude-sonnet-4.6` | 200k | 1× | 主力模型 |

### 6.2 代理可用但未注册（按需添加）

| 底层模型 ID | ctx | 费率倍数 | 备注 |
|---|---|---|---|
| `claude-opus-4.7` | 144k | 7.5× | 高质量，费率高 |
| `claude-sonnet-4.5` | 144k | 1× | |
| `claude-sonnet-4` | 216k | 1× | |
| `claude-haiku-4.5` | 144k | 0.33× | 轻量 |
| `gpt-5.3-codex` | 400k | 1× | 代码优化 |
| `gpt-5.2-codex` | 400k | 1× | 代码优化 |
| `gpt-5.2` | 264k | 1× | |
| `gpt-5-mini` | 264k | 免费 | |
| `gpt-4.1` | 128k | 免费 | |

---

## 7. OpenClaw 配置要点

`openclaw.json` 里要检查两处：

### 7.1 provider 指向本地代理

```json
"providers": {
  "copilot-proxy": {
    "api": "openai-completions",
    "baseUrl": "http://127.0.0.1:3456/v1",
    "headers": {
      "Authorization": "Bearer copilot-proxy-local"
    }
  }
}
```

### 7.2 agents.defaults.models 注册模型

```json
"copilot-proxy/gpt-5.4": {},
"copilot-proxy/gpt-5.4-mini": {},
"copilot-proxy/claude-sonnet-4.6": {}
```

> `claude-opus-4.7` 已从默认注册中移除（费率 7.5×，按需手动添加）。

---

## 8. 验证步骤

### 8.1 语法检查

```bash
cd /Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy
for f in copilot-proxy/*.mjs; do node --check "$f" && echo "$f OK"; done
```

### 8.2 启动代理

```bash
node /Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy/copilot-proxy/index.mjs --port 3456
```

### 8.3 健康检查

```bash
curl -s http://127.0.0.1:3456/health
```

### 8.4 模型检查

```bash
curl -s http://127.0.0.1:3456/v1/models
```

### 8.5 对话检查

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Reply with exactly pong"}],
    "stream": false
  }'
```

### 8.6 指标检查

```bash
curl -s http://127.0.0.1:3456/metrics | python3 -m json.tool
```

### 8.7 OpenClaw 配置检查

改完配置后必须运行：

```bash
openclaw doctor
```

---

## 9. 常见坑

### 9.0 假活着孤儿进程

现象：

- `ps` 里看得到 `node copilot-openai-proxy.mjs`
- 但 `lsof -iTCP:3456 -sTCP:LISTEN` 没监听
- `curl /health` 连不上

原因：

- 之前通过 OpenClaw `exec` 或临时 shell 拉起，残留成孤儿进程
- 进程存在不等于服务真的在监听

处理：

- 不再依赖临时后台进程
- 统一切到 `launchd` 常驻
- 用固定日志和 watcher 做健康检查

### 9.1 SDK 包名错

现象：

- `ERR_MODULE_NOT_FOUND`
- `Package subpath not exported`
- `CopilotClient` 导入失败

处理：

- 安装 `@github/copilot-sdk`
- 不要再用 `@github/copilot/sdk`

### 9.2 模型 ID 格式不一致

现象：

- provider 里写的是 `claude-sonnet-4-6`
- 真实返回却是 `claude-sonnet-4.6`
- OpenClaw 选型时出现隐藏错配

处理：

- 新 provider 统一用真实返回值
- 当前标准写法：`claude-sonnet-4.6`
- 不要为了 Copilot 模型去改原有 `cli-proxy` 的既有模型 ID

### 9.3 provider 端口没切过来

现象：

- 新 provider 没有指向 `127.0.0.1:3456`
- 或者误把原有 `cli-proxy` 改成了 Copilot 端口

处理：

- 新增独立 provider，例如 `providers.copilot-proxy`
- 把它的 `baseUrl` 设为：
  `http://127.0.0.1:3456/v1`

### 9.4 代理能启动，但没接进 OpenClaw

现象：

- 直接 curl 正常
- OpenClaw 里模型不可用或仍走旧模型

处理：

- 检查 `agents.defaults.models`
- 检查调用时是否使用 `copilot-proxy/<model-id>`
- 改完后运行 `openclaw doctor`
- 必要时重启 gateway

---

## 10. 建议运维动作

### 10.1 日志观察

建议把代理 stdout/stderr 重定向到单独日志文件。

### 10.2 后台守护（已完成）

当前已通过 launchd 常驻，无需手动补：

- LaunchAgent：`~/Library/LaunchAgents/ai.openclaw.copilot-openai-proxy.plist`
- 启动脚本：`/Users/shuaihui/.openclaw/bin/start-copilot-openai-proxy.sh`
- 日志：`~/.openclaw/logs/copilot-openai-proxy.stdout.log` / `stderr.log`
- Watcher：`~/Library/LaunchAgents/ai.openclaw.copilot-openai-proxy.watch.plist`

详见 §4.2 / §4.3。

### 10.3 模型扩容时的原则

新增模型时同步改三处：

1. 代理 `/v1/models` 对应底层模型（代理动态暴露，通常不需改代码）
2. `providers.copilot-proxy`（确认 provider 存在，baseUrl 正确）
3. `agents.defaults.models`（注册 `copilot-proxy/<model-id>`）

不允许只改其中一处。

---

## 11. 当前状态基线

**最后更新：2026-04-23**

架构：
- 模块化 ESM（9 个 .mjs 文件）
- launchd 常驻 + watcher
- metrics.mjs 请求统计（token 计数已移除，改走 console.debug，/metrics 不再暴露 token 字段）
- 静默重试（超时 + headers 未发时自动重建 session 重跑一次）
- 死代码清理：移除 timeout.mjs 中旧函数 `sendAndWaitNoTimeout`，统一使用 `sendWithActivityTimeout`

已验证正常：

- `/health` ✅
- `/v1/models` ✅
- `/v1/chat/completions` ✅
- `/metrics` ✅
- 语法检查全 OK ✅

已注册模型（OpenClaw）：
- `copilot-proxy/gpt-5.4`
- `copilot-proxy/gpt-5.4-mini`
- `copilot-proxy/claude-sonnet-4.6`

### 11.1 当前恢复策略：零自动重放优先

从 2026-04-23 起，恢复链路改成：**优先不增加额外模型请求，其次保证状态干净和行为可预测**。

核心规则：

1. **stale / synthetic tool repair**
   - 如果检测到 trailing tool result 全是修复噪音（如 gateway restart / transcript repair）
   - **不会自动 replay 到 Copilot**
   - 直接本地返回：`ignored_stale_tool_results`

2. **missing tool result**
   - 如果 session 正在等 tool result，但本次请求无法补齐 pending tool calls
   - **不会自动补跑，不会自动重放**
   - 直接关闭旧 session，并返回：`tool_result_recovery_blocked`
   - 由上游/用户决定是否重新发送上一条请求

3. **silent-retry 仅保留最保守分支**
   - 只在以下条件同时满足时才允许重试一次：
     - 超时类型是 `TURN_EVENT_TIMEOUT` 或 `SEND_TIMEOUT`
     - 响应头尚未发出
     - `didReachCopilot !== true`
   - 也就是：**只有能确认请求根本没触达 Copilot，才允许静默重试**

4. **watcher 只负责告警，不负责自动补跑当前 turn**

这套策略的目标不是“最大化自动自愈”，而是：

- 控制额外请求次数
- 避免把脏状态继续喂给模型
- 让异常表现更容易排查

### 11.2 与旧策略的取舍

旧策略更偏向“自动自愈优先”，可能包含：

- synthetic missing tool result continuation
- close + recreate + replay current request
- 更宽松的 silent-retry

它的优点是：
- 某些异常下用户体感更连续

它的缺点是：
- **不一定更省真实模型请求次数**
- 更容易把脏状态继续延长
- 排障更难，因为代理会在后台偷偷补动作

所以当前默认结论是：

- **最省人工重试次数**：旧策略有时更像
- **更稳、更可控**：零自动重放优先更合适

### 11.3 旧方案安全备份

本次改造前的恢复链路已单独备份：

```text
/Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy/backup/2026-04-23-zero-auto-replay/
```

当前已备份文件：

- `index_恢复链路改造前.mjs`
- `timeout_恢复链路改造前.mjs`
- `tools_恢复链路改造前.mjs`

如果后续要回看旧逻辑、做差异对比、或局部回滚，以该目录为准。

后续如果失效，先查：

1. SDK 包是否还在（`node_modules/@github/copilot-sdk`）
2. Copilot CLI 是否可用（`/opt/homebrew/bin/copilot`）
3. provider baseUrl 是否被改回旧地址
4. OpenClaw 配置里是否又出现模型 ID 漂移（用 `-` 而非 `.`）
5. launchd 服务是否还在跑：`launchctl print gui/$(id -u)/ai.openclaw.copilot-openai-proxy`
