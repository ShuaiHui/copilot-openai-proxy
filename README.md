# Copilot OpenAI Proxy

## 这是什么

GitHub Copilot 订阅里包含了 `gpt-5.4`、`claude-sonnet-4.6`、`claude-opus-4.7` 这些高端模型，但没有直接的 API 入口。这个脚本的作用是：

**在本地启动一个 HTTP 服务，把 Copilot 包装成标准 OpenAI 格式的接口，让 OpenClaw 能像用普通 API 一样调用 Copilot 模型。**

整条链路长这样：

```
你发消息
  → OpenClaw 路由到 copilot-proxy provider
    → 请求发到本地 http://127.0.0.1:3456
      → copilot-openai-proxy.mjs 脚本处理
        → 通过 @github/copilot-sdk 转发给 GitHub Copilot
          → 返回结果
```

---

## 使用前提

1. 已安装 GitHub Copilot CLI（路径：`/opt/homebrew/bin/copilot`）
2. 已登录 GitHub 账号并激活 Copilot 订阅
3. 已安装依赖包（只需装一次）：

```bash
cd /Users/shuaihui/.openclaw/scripts
npm install @github/copilot-sdk@0.2.2
```

---

## 每次使用前：启动代理

代理不会自动启动，每次开机或重启后需要手动跑：

```bash
node /Users/shuaihui/.openclaw/scripts/copilot-openai-proxy.mjs --host 127.0.0.1 --port 3456
```

启动后终端会持续运行，**不要关掉这个窗口**。

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
/model copilot-proxy/claude-sonnet-4.6
/model copilot-proxy/claude-opus-4.7
```

切回默认模型：

```
/model cli-proxy/gemini-3-flash-preview
```

---

## 文件在哪

| 文件 | 说明 |
|------|------|
| `/Users/shuaihui/.openclaw/scripts/copilot-openai-proxy.mjs` | 代理脚本本体 |
| `/Users/shuaihui/.openclaw/scripts/node_modules/@github/copilot-sdk/` | SDK 依赖 |
| `/Users/shuaihui/.openclaw/openclaw.json` | OpenClaw 配置（已接入） |

---

## 常见问题

**Q: 代理启动报错 `Cannot find module '@github/copilot-sdk'`**

原因：依赖没装。重新跑：
```bash
cd /Users/shuaihui/.openclaw/scripts && npm install @github/copilot-sdk@0.2.2
```

**Q: curl /health 没有响应**

原因：代理没有在跑。重新启动脚本。

**Q: 模型切换后请求超时或报错**

原因：Copilot CLI 可能需要重新登录。跑 `/opt/homebrew/bin/copilot` 检查登录状态。

**Q: 机器重启后模型不可用**

原因：代理进程没有守护，重启后需要手动重新启动脚本。

---

## 技术细节

详见 [SKILL.md](./SKILL.md)，包含 SDK 坑点、OpenClaw 配置结构、接口文档和调试方法。
