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

### 2.1 代理脚本

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
cd /Users/shuaihui/.openclaw/scripts
npm install @github/copilot-sdk@0.2.2
```

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
node /Users/shuaihui/.openclaw/scripts/copilot-openai-proxy.mjs --host 127.0.0.1 --port 3456
```

### 4.2 推荐常驻方式（launchd）

生产环境不要再用临时 `exec` / `nohup` 孤儿进程常驻。

当前稳定方案：

- LaunchAgent：`~/Library/LaunchAgents/ai.openclaw.copilot-openai-proxy.plist`
- 启动脚本：`/Users/shuaihui/.openclaw/bin/start-copilot-openai-proxy.sh`
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

职责：

1. 每 60 秒检查一次 `http://127.0.0.1:3456/health`
2. 首次失败时发一条 OpenClaw wake 提醒
3. 恢复后清理告警锁文件，避免重复轰炸

### 4.4 常用参数

```bash
--host 127.0.0.1
--port 3456
--default-model gpt-5.4
--cwd /Users/shuaihui/.openclaw/workspace
--session-ttl-ms 1200000
--send-timeout-ms 1200000
```

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

### 5.4 调试接口

```http
GET    /debug/sessions
POST   /debug/sessions/:key/close
DELETE /debug/sessions/:key
```

---

## 6. 当前接入的模型

用于 OpenClaw 时，模型 ID 写成：

- `copilot-proxy/gpt-5.4`
- `copilot-proxy/claude-sonnet-4.6`
- `copilot-proxy/claude-opus-4.7`

代理后端实际返回的底层模型 ID：

- `gpt-5.4`
- `claude-sonnet-4.6`
- `claude-opus-4.7`

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
"copilot-proxy/claude-sonnet-4.6": {},
"copilot-proxy/claude-opus-4.7": {}
```

---

## 8. 验证步骤

### 8.1 语法检查

```bash
node --check /Users/shuaihui/.openclaw/scripts/copilot-openai-proxy.mjs
```

### 8.2 启动代理

```bash
node /Users/shuaihui/.openclaw/scripts/copilot-openai-proxy.mjs --port 3456
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

### 8.6 OpenClaw 配置检查

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

### 10.2 后台守护

建议后续补一层：

- launchd
- cron @reboot
- 或其他常驻管理方式

### 10.3 模型扩容时的原则

新增模型时同步改三处：

1. 代理 `/v1/models` 对应底层模型
2. `providers.cli-proxy.models`
3. `agents.defaults.models`

不允许只改其中一处。

---

## 11. 当前状态基线

本技能建立时，已确认：

- 代理脚本可启动
- `/health` 正常
- `/v1/models` 正常
- `/v1/chat/completions` 正常
- 已加入模型：
  - `gpt-5.4`
  - `claude-sonnet-4.6`
  - `claude-opus-4.7`

后续如果失效，先查：

1. SDK 包是否还在
2. Copilot CLI 是否可用
3. provider baseUrl 是否被改回旧地址
4. OpenClaw 配置里是否又出现模型 ID 漂移
