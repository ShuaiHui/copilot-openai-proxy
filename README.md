# Copilot OpenAI Proxy

## 这是什么

GitHub Copilot 订阅里包含了 `gpt-5.4`、`claude-sonnet-4.6`、`claude-opus-4.7` 这些高端模型，但没有直接的 API 入口。这个技能的作用是：

**在本地启动一个 HTTP 服务，把 Copilot 包装成标准 OpenAI 格式的接口，让 OpenClaw 能像用普通 API 一样调用 Copilot 模型。**

整条链路长这样：

```
你发消息
  → OpenClaw 路由到 copilot-proxy provider
    → 请求发到本地 http://127.0.0.1:3456
      → copilot-proxy/index.mjs 处理
        → 通过 @github/copilot-sdk 转发给 GitHub Copilot
          → 返回结果
```

---

## 使用前提

1. 已安装 GitHub Copilot CLI（路径：`/opt/homebrew/bin/copilot`）
2. 已登录 GitHub 账号并激活 Copilot 订阅
3. 已安装依赖包（只需装一次）：

```bash
cd /Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy
npm install @github/copilot-sdk@0.2.2
```

---

## 启动方式

### 方式一：launchd 常驻（推荐，已部署）

代理通过 launchd 自动常驻，开机自启，无需手动干预：

```bash
# 检查状态
launchctl print gui/$(id -u)/ai.openclaw.copilot-openai-proxy | head -30

# 重启服务
launchctl kickstart -k gui/$(id -u)/ai.openclaw.copilot-openai-proxy
```

日志位置：

```
~/.openclaw/logs/copilot-openai-proxy.stdout.log
~/.openclaw/logs/copilot-openai-proxy.stderr.log
```

### 方式二：手动临时启动

```bash
node /Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy/copilot-proxy/index.mjs \
  --host 127.0.0.1 \
  --port 3456
```

验证是否正常：

```bash
# 检查服务是否活着
curl http://127.0.0.1:3456/health

# 查看可用模型
curl http://127.0.0.1:3456/v1/models
```

---

## 在 OpenClaw 里切换到 Copilot 模型

代理启动后，直接用 `/model` 命令切换：

```
/model copilot-proxy/gpt-5.4
/model copilot-proxy/gpt-5.4-mini
/model copilot-proxy/claude-sonnet-4.6
```

切回默认模型：

```
/model cli-proxy/gemini-3-flash-preview
```

---

## 文件在哪

| 文件 | 说明 |
|------|------|
| `copilot-proxy/index.mjs` | 代理入口 + HTTP server |
| `copilot-proxy/config.mjs` | 参数默认值 + CLI 解析 |
| `copilot-proxy/session.mjs` | Session 生命周期管理 |
| `copilot-proxy/messages.mjs` | 消息解析 + prompt 构建 |
| `copilot-proxy/tools.mjs` | tool call 处理 |
| `copilot-proxy/image.mjs` | 图片附件处理 |
| `copilot-proxy/timeout.mjs` | 超时控制 + 工具心跳推送 |
| `copilot-proxy/events.mjs` | turn 事件队列 |
| `copilot-proxy/metrics.mjs` | 请求计数 / 延迟 / token 统计，供 `/metrics` 端点使用 |
| `daemon/start.sh` | 启动脚本源模板（launchd 实际用 `~/.openclaw/bin/start-copilot-openai-proxy.sh`） |
| `daemon/watch.sh` | watcher 脚本源模板（launchd 实际用 `~/.openclaw/bin/copilot-openai-proxy-watch.sh`） |
| `daemon/healthcheck.sh` | 单次健康检查脚本 |
| `node_modules/` | 本地 npm 依赖（@github/copilot-sdk） |

---

## 常见问题

**Q: 代理启动报错 `Cannot find module '@github/copilot-sdk'`**

原因：依赖没装。重新跑：
```bash
cd /Users/shuaihui/.openclaw/workspace/skills/copilot-openai-proxy
npm install @github/copilot-sdk@0.2.2
```

**Q: curl /health 没有响应**

原因：代理没有在跑。检查 launchd 状态或手动启动。

**Q: 模型切换后请求超时或报错**

原因：Copilot CLI 可能需要重新登录。跑 `/opt/homebrew/bin/copilot` 检查登录状态。

**Q: 机器重启后模型不可用**

launchd 会自动拉起。若服务异常，运行：
```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.copilot-openai-proxy
```

---

## 技术细节

详见 [SKILL.md](./SKILL.md)，包含 SDK 坑点、OpenClaw 配置结构、接口文档、session 请求特性和调试方法。
