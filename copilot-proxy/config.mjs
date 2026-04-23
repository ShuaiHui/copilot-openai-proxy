// config.mjs — DEFAULTS, constants, CLI arg parsing, misc pure helpers
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 3456,
  defaultModel: 'claude-sonnet-4.6',
  timeoutFallbackModel: 'gpt-5.4', // ✅ 超时恢复时切换到此模型
  cwd: process.cwd(),
  cliPath: '/opt/homebrew/bin/copilot',
  logLevel: 'warning',
  cliArgs: ['--no-custom-instructions', '--no-auto-update'],
  sessionTtlMs: 30 * 60 * 1000,
  sendTimeoutMs: 6 * 60 * 1000,      // ✅ 6 分钟，卡死最多等 6 分钟
  turnEventTimeoutMs: 180 * 1000,    // ✅ 180 秒，turn 事件超时（工具心跳刷新后更宽松）
};

export const ASK_USER_PROMPT = [
  '任务即将完成前，请优先使用 ask_user (#askUser) 工具向用户汇报，并询问是否还有其他事项。',
  '固定收尾话术：还有没有补充要做的事情？请一次性列出，我将继续在本轮内处理。',
  '如果 ask_user 工具暂时不可用，可以用普通文本回复，等待用户下一条消息。',
  '原则上，未经用户明确同意，不主动结束本轮。',
].join('\n');

export const OPENAI_FUNCTION_TOOL_TYPE = 'function';
export const COPILOT_ALLOWED_BUILT_IN_TOOLS = new Set(['ask_user']);
export const PROXY_TMP_DIR = path.join(os.tmpdir(), 'copilot-openai-proxy');
export const REMOTE_IMAGE_CACHE_MAX = 100;

export const DEFAULT_COPILOT_BUILT_IN_TOOLS = [
  'bash',
  'write_bash',
  'read_bash',
  'stop_bash',
  'list_bash',
  'str_replace_editor',
  'web_fetch',
  'report_intent',
  'show_file',
  'fetch_copilot_cli_documentation',
  'ask_user',
  'grep',
  'glob',
  'task',
];

export function nowMs() {
  return Date.now();
}

export function parseArgs(argv) {
  const args = [...argv];
  const opts = {
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    defaultModel: DEFAULTS.defaultModel,
    cwd: DEFAULTS.cwd,
    sessionTtlMs: DEFAULTS.sessionTtlMs,
    sendTimeoutMs: DEFAULTS.sendTimeoutMs,
    turnEventTimeoutMs: DEFAULTS.turnEventTimeoutMs,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--host':
        opts.host = args[++i] ?? DEFAULTS.host;
        break;
      case '--port':
        opts.port = Number(args[++i] ?? DEFAULTS.port);
        break;
      case '--default-model':
        opts.defaultModel = args[++i] ?? DEFAULTS.defaultModel;
        break;
      case '--cwd':
        opts.cwd = path.resolve(args[++i] ?? DEFAULTS.cwd);
        break;
      case '--session-ttl-ms':
        opts.sessionTtlMs = Number(args[++i] ?? DEFAULTS.sessionTtlMs);
        break;
      case '--send-timeout-ms':
        opts.sendTimeoutMs = Number(args[++i] ?? DEFAULTS.sendTimeoutMs);
        break;
      case '--turn-event-timeout-ms':
        opts.turnEventTimeoutMs = Number(args[++i] ?? DEFAULTS.turnEventTimeoutMs);
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

export function printUsage() {
  console.log(`Usage:
  node copilot-proxy/index.mjs [--host 127.0.0.1] [--port 3456] [--default-model claude-sonnet-4.6] [--cwd <dir>] [--session-ttl-ms 0] [--send-timeout-ms 1200000]

OpenAI-compatible endpoints:
  GET  /health
  GET  /v1/models
  POST /v1/chat/completions

Debug/session endpoints:
  GET    /debug/sessions
  POST   /debug/sessions/:key/close
  DELETE /debug/sessions/:key
  GET    /metrics
  GET    /v1/logs              query params: limit, model, status, since (epoch ms)
  GET    /v1/logs/stats        query params: days (default 7)

Optional request features:
  - Header x-copilot-session-key: reuse a live Copilot session across requests
  - Body field session_key: same as header, useful when custom headers are hard to set
  - Header x-copilot-new-session: 1 / true / yes => force close old session and start a new one
  - Body field new_session: same as header; intended to map from OpenClaw /new semantics
  - If the live session is waiting on ask_user, the next POST /v1/chat/completions with the same
    session key will be treated as the user's reply to that pending ask_user instead of a new send
`);
}
