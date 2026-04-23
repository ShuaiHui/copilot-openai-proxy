#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CopilotClient, approveAll } from '@github/copilot-sdk';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3456,
  defaultModel: 'claude-sonnet-4.6',
  timeoutFallbackModel: 'gpt-5.4', // ✅ 超时恢复时切换到此模型
  cwd: process.cwd(),
  cliPath: '/opt/homebrew/bin/copilot',
  logLevel: 'warning',
  cliArgs: ['--no-custom-instructions', '--no-auto-update'],
  sessionTtlMs: 30 * 60 * 1000,
  sendTimeoutMs: 6 * 60 * 1000, // ✅ 6 分钟，卡死最多等 6 分钟
  turnEventTimeoutMs: 90 * 1000, // ✅ 90 秒，turn 事件超时快速发现
};

const ASK_USER_PROMPT = [
  '任务即将完成前，请优先使用 ask_user (#askUser) 工具向用户汇报，并询问是否还有其他事项。',
  '固定收尾话术：还有没有补充要做的事情？请一次性列出，我将继续在本轮内处理。',
  '如果 ask_user 工具暂时不可用，可以用普通文本回复，等待用户下一条消息。',
  '原则上，未经用户明确同意，不主动结束本轮。',
].join('\n');

const OPENAI_FUNCTION_TOOL_TYPE = 'function';
const COPILOT_ALLOWED_BUILT_IN_TOOLS = new Set(['ask_user']);
const PROXY_TMP_DIR = path.join(os.tmpdir(), 'copilot-openai-proxy');
const REMOTE_IMAGE_CACHE_MAX = 100; // LRU 上限，超出时清理最旧的条目
const remoteImageCache = new Map(); // url → localFilePath (avoids re-downloading same image URL)

function remoteImageCacheSet(url, filePath) {
  // LRU eviction: delete oldest entry when limit is reached
  if (remoteImageCache.size >= REMOTE_IMAGE_CACHE_MAX) {
    const oldestKey = remoteImageCache.keys().next().value;
    remoteImageCache.delete(oldestKey);
  }
  remoteImageCache.set(url, filePath);
}
const DEFAULT_COPILOT_BUILT_IN_TOOLS = [
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

function shouldForceAskUser(messages, clientTools = []) {
  const raw = String(process.env.COPILOT_FORCE_ASK_USER ?? '1').toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(raw)) {
    return false;
  }

  return true;
}

function appendAskUserPrompt(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return trimmed;
  return `${trimmed}\n\n${ASK_USER_PROMPT}`;
}

function prependAskUserLabel(text) {
  return String(text ?? '').trim();
}

function prependAskUserPromptAsSystem(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return trimmed;
  return `System:\n${ASK_USER_PROMPT}\n\n${trimmed}`;
}

function buildChannelBehaviorInstruction(messageChannel) {
  const channel = String(messageChannel ?? '').trim();
  if (!channel) return '';
  return [
    `System:`,
    `Current OpenClaw delivery channel: ${channel}.`,
    `You are already in the live conversation for this channel.`,
    `Do not use the message tool to reply to the current user in the current conversation.`,
    `Do not reply with normal assistant text in the current conversation.`,
    `For every user-facing reply in the current conversation, you must use ask_user, matching the existing OpenClaw webchat behavior.`,
    `Reserve the message tool only for contacting a different person, a different thread, or a different channel explicitly requested by the user.`,
  ].join('\n');
}

function appendSystemInstruction(text, instruction) {
  const base = String(text ?? '').trim();
  const extra = String(instruction ?? '').trim();
  if (!base) return extra;
  if (!extra) return base;
  return `${base}\n\n${extra}`;
}

function parseArgs(argv) {
  const args = [...argv];
  const opts = {
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    defaultModel: DEFAULTS.defaultModel,
    cwd: DEFAULTS.cwd,
    sessionTtlMs: DEFAULTS.sessionTtlMs,
    sendTimeoutMs: DEFAULTS.sendTimeoutMs,
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

function getHeaderValue(req, name) {
  const direct = req.headers?.[name];
  if (typeof direct === 'string') return direct.trim();
  if (Array.isArray(direct)) {
    const first = direct.find((value) => typeof value === 'string' && value.trim());
    return typeof first === 'string' ? first.trim() : null;
  }
  return null;
}

function printUsage() {
  console.log(`Usage:
  node scripts/copilot-openai-proxy.mjs [--host 127.0.0.1] [--port 3456] [--default-model claude-sonnet-4.5] [--cwd <dir>] [--session-ttl-ms 0] [--send-timeout-ms 1200000]

OpenAI-compatible endpoints:
  GET  /health
  GET  /v1/models
  POST /v1/chat/completions

Debug/session endpoints:
  GET    /debug/sessions
  POST   /debug/sessions/:key/close
  DELETE /debug/sessions/:key

Optional request features:
  - Header x-copilot-session-key: reuse a live Copilot session across requests
  - Body field session_key: same as header, useful when custom headers are hard to set
  - Header x-copilot-new-session: 1 / true / yes => force close old session and start a new one
  - Body field new_session: same as header; intended to map from OpenClaw /new semantics
  - If the live session is waiting on ask_user, the next POST /v1/chat/completions with the same
    session key will be treated as the user's reply to that pending ask_user instead of a new send
`);
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.shouldKeepAlive = false;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    connection: 'close',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendSseChatCompletion(res, response, extraHeaders = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...extraHeaders,
  });

  const base = {
    id: response.id,
    object: 'chat.completion.chunk',
    created: response.created,
    model: response.model,
  };

  const writeChunk = (chunk) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  writeChunk({
    ...base,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      },
    ],
  });

  const content = textPreviewFromAssistantContent(response?.choices?.[0]?.message?.content ?? '');
  const toolCalls = Array.isArray(response?.choices?.[0]?.message?.tool_calls)
    ? response.choices[0].message.tool_calls
    : [];
  if (content) {
    writeChunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    });
  }

  if (toolCalls.length) {
    writeChunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: toolCalls },
          finish_reason: null,
        },
      ],
    });
  }

  writeChunk({
    ...base,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: response?.choices?.[0]?.finish_reason ?? 'stop',
      },
    ],
  });

  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Flush the tail of an already-open SSE stream (headers already written).
 * Sends optional extra text content, tool call deltas, finish chunk, and [DONE].
 */
function flushSseStream(res, sseBase, { extraContent = '', toolCalls = [], finishReason = 'stop' } = {}) {
  const writeChunk = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (extraContent) {
    writeChunk({ ...sseBase, choices: [{ index: 0, delta: { content: extraContent }, finish_reason: null }] });
  }
  if (toolCalls.length) {
    writeChunk({ ...sseBase, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] });
  }
  writeChunk({ ...sseBase, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(raw);
}

function toOpenAIModels(models) {
  return {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'copilot',
      name: m.name,
      context_window: m.capabilities?.limits?.max_context_window_tokens,
      max_prompt_tokens: m.capabilities?.limits?.max_prompt_tokens,
      reasoning: m.capabilities?.supports?.reasoningEffort ?? false,
      billing: m.billing ?? null,
    })),
  };
}

function messageTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text ?? '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractSystemMessageContent(messages) {
  const parts = messages
    .filter((msg) => msg.role === 'system')
    .map((msg) => messageTextContent(msg.content).trim())
    .filter(Boolean);
  return parts.length ? parts.join('\n\n') : null;
}

function transcriptFromMessages(messages) {
  return messages
    .filter((msg) => msg.role !== 'system')
    .map((msg) => {
      const prefix = msg.role === 'assistant'
          ? 'Assistant'
          : msg.role === 'tool'
            ? 'Tool'
            : 'User';
      return `${prefix}:\n${messageTextContent(msg.content)}`;
    })
    .join('\n\n');
}

function latestUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return messageTextContent(messages[i].content);
    }
  }
  return '';
}

function latestToolMessages(messages) {
  const results = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'tool' || message?.role === 'toolResult' || message?.type === 'toolResult') {
      results.unshift(message);
      continue;
    }
    if (results.length) break;
  }
  return results;
}

function latestUserMessageObject(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return messages[i];
    }
  }
  return null;
}

function looksLikeOpenClawNewSessionPrompt(messages) {
  const pattern = /A new session was started via \/new or \/reset\./i;
  return pattern.test(latestUserMessage(messages));
}

function buildContinuationInjectedAnswer(text) {
  const continuationInstruction = process.env.COPILOT_CONTINUATION_INSTRUCTION?.trim();
  if (continuationInstruction) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return trimmed;
    return `${trimmed}\n\n${continuationInstruction}`;
  }
  return String(text ?? '').trim();  // No more ASK_USER_PROMPT injection — now handled at session level
}

function shouldRenderAskUserAsCompleted() {
  const raw = String(process.env.COPILOT_RENDER_ASK_USER_AS_COMPLETED ?? '1').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function normalizeUserInputReply(raw, pendingUserInput) {
  const text = String(raw ?? '').trim();
  const choices = Array.isArray(pendingUserInput?.choices) ? pendingUserInput.choices : [];

  if (text && choices.length) {
    const asNumber = Number(text);
    if (Number.isInteger(asNumber) && choices[asNumber - 1]) {
      return {
        answer: buildContinuationInjectedAnswer(choices[asNumber - 1]),
        wasFreeform: false,
      };
    }

    const matchedChoice = choices.find((choice) => choice === text);
    if (matchedChoice) {
      return {
        answer: buildContinuationInjectedAnswer(matchedChoice),
        wasFreeform: false,
      };
    }
  }

  return {
    answer: buildContinuationInjectedAnswer(text),
    wasFreeform: true,
  };
}

function normalizeOpenAITools(tools) {
  if (!Array.isArray(tools)) return [];

  return tools
    .map((tool) => {
      if (tool?.type !== OPENAI_FUNCTION_TOOL_TYPE) return null;
      const fn = tool.function ?? {};
      const name = typeof fn.name === 'string' ? fn.name.trim() : '';
      if (!name) return null;
      return {
        type: OPENAI_FUNCTION_TOOL_TYPE,
        function: {
          name,
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
        },
      };
    })
    .filter(Boolean);
}

function shouldExposeOpenClawMessageTool() {
  const raw = String(process.env.COPILOT_EXPOSE_OPENCLAW_MESSAGE_TOOL ?? '').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function filterClientToolsForCopilot(clientTools) {
  if (shouldExposeOpenClawMessageTool()) {
    return clientTools;
  }

  return clientTools.filter((tool) => tool.function.name !== 'message');
}

function serializeClientTools(tools) {
  return JSON.stringify(
    tools.map((tool) => ({
      type: OPENAI_FUNCTION_TOOL_TYPE,
      function: {
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      },
    }))
  );
}

function normalizeCopilotBuiltInToolNames(result) {
  if (!Array.isArray(result?.tools)) return [];
  return result.tools
    .map((tool) => (typeof tool?.name === 'string' ? tool.name.trim() : ''))
    .filter(Boolean);
}

function buildExcludedCopilotTools(builtInToolNames) {
  return [...new Set(
    builtInToolNames.filter((name) => !COPILOT_ALLOWED_BUILT_IN_TOOLS.has(name))
  )];
}

function normalizeToolCallArguments(rawArgs) {
  if (rawArgs == null) return {};
  if (typeof rawArgs === 'string') {
    try {
      return JSON.parse(rawArgs);
    } catch {
      return {};
    }
  }
  if (typeof rawArgs === 'object') return rawArgs;
  return {};
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType ?? '').trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/svg+xml') return '.svg';
  return '';
}

function extensionFromUrlString(urlString) {
  try {
    const parsed = new URL(urlString);
    const ext = path.extname(parsed.pathname || '').trim();
    return ext || '';
  } catch {
    return path.extname(String(urlString ?? '').trim()) || '';
  }
}

function imageAttachmentFromPart(part, index, messageIndex) {
  if (!part || typeof part !== 'object') return null;

  const partType = typeof part.type === 'string' ? part.type : '';
  const imageUrlField = part.image_url ?? part.imageUrl ?? null;
  const imageUrl = typeof imageUrlField === 'string'
    ? imageUrlField
    : (typeof imageUrlField?.url === 'string' ? imageUrlField.url : null);
  const directUrl = typeof part.url === 'string' ? part.url : null;
  const mimeType = typeof part.mimeType === 'string'
    ? part.mimeType
    : (typeof part.media_type === 'string' ? part.media_type : null);
  const base64Data = typeof part.data === 'string'
    ? part.data
    : (typeof part.base64 === 'string' ? part.base64 : null);

  if (partType === 'image' && base64Data) {
    return {
      kind: 'base64',
      mimeType: mimeType || 'image/png',
      data: base64Data,
      displayName: `image-${messageIndex + 1}-${index + 1}${extensionForMimeType(mimeType || 'image/png')}`,
    };
  }

  const sourceUrl = imageUrl || directUrl;
  if (!sourceUrl) return null;

  if (sourceUrl.startsWith('data:')) {
    return {
      kind: 'data-url',
      url: sourceUrl,
      displayName: `image-${messageIndex + 1}-${index + 1}`,
    };
  }

  if (sourceUrl.startsWith('file://')) {
    return {
      kind: 'file-url',
      url: sourceUrl,
      displayName: path.basename(fileURLToPath(sourceUrl)),
    };
  }

  if (sourceUrl.startsWith('/')) {
    return {
      kind: 'path',
      path: sourceUrl,
      displayName: path.basename(sourceUrl),
    };
  }

  if (/^https?:\/\//i.test(sourceUrl)) {
    return {
      kind: 'remote-url',
      url: sourceUrl,
      displayName: `image-${messageIndex + 1}-${index + 1}${extensionFromUrlString(sourceUrl)}`,
    };
  }

  return null;
}

function collectImageSourcesFromMessage(message, messageIndex = 0) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  return content
    .map((part, index) => imageAttachmentFromPart(part, index, messageIndex))
    .filter(Boolean);
}

async function materializeImageAttachment(source, attachmentIndex = 0) {
  if (!source) return null;

  if (source.kind === 'path') {
    return {
      type: 'file',
      path: source.path,
      displayName: source.displayName || path.basename(source.path),
    };
  }

  if (source.kind === 'file-url') {
    const filePath = fileURLToPath(source.url);
    return {
      type: 'file',
      path: filePath,
      displayName: source.displayName || path.basename(filePath),
    };
  }

  await fs.mkdir(PROXY_TMP_DIR, { recursive: true });

  if (source.kind === 'base64') {
    const extension = extensionForMimeType(source.mimeType) || '.bin';
    const filePath = path.join(PROXY_TMP_DIR, `${crypto.randomUUID()}-${attachmentIndex}${extension}`);
    await fs.writeFile(filePath, Buffer.from(source.data, 'base64'));
    return {
      type: 'file',
      path: filePath,
      displayName: source.displayName || path.basename(filePath),
    };
  }

  if (source.kind === 'data-url') {
    const match = source.url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
    if (!match) {
      throw new Error('Unsupported data URL image payload');
    }
    const mimeType = match[1] || 'application/octet-stream';
    const encoded = match[3] || '';
    const isBase64 = Boolean(match[2]);
    const extension = extensionForMimeType(mimeType) || '.bin';
    const filePath = path.join(PROXY_TMP_DIR, `${crypto.randomUUID()}-${attachmentIndex}${extension}`);
    const buffer = isBase64
      ? Buffer.from(encoded, 'base64')
      : Buffer.from(decodeURIComponent(encoded), 'utf8');
    await fs.writeFile(filePath, buffer);
    return {
      type: 'file',
      path: filePath,
      displayName: source.displayName ? `${source.displayName}${extension}` : path.basename(filePath),
    };
  }

  if (source.kind === 'remote-url') {
    // Check cache: skip re-download if we fetched this URL before and file still exists
    if (remoteImageCache.has(source.url)) {
      const cachedPath = remoteImageCache.get(source.url);
      try {
        await fs.access(cachedPath);
        return {
          type: 'file',
          path: cachedPath,
          displayName: source.displayName || path.basename(cachedPath),
        };
      } catch {
        remoteImageCache.delete(source.url); // file was deleted, fall through to re-fetch
      }
    }
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image attachment: ${response.status} ${response.statusText}`);
    }
    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const extension = extensionFromUrlString(source.url) || extensionForMimeType(mimeType) || '.bin';
    const filePath = path.join(PROXY_TMP_DIR, `${crypto.randomUUID()}-${attachmentIndex}${extension}`);
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
    remoteImageCacheSet(source.url, filePath);
    return {
      type: 'file',
      path: filePath,
      displayName: source.displayName || path.basename(filePath),
    };
  }

  return null;
}

async function collectCopilotImageAttachments(messages, latestOnly = false) {
  const userMessages = latestOnly
    ? [latestUserMessageObject(messages)].filter(Boolean)
    : messages.filter((message) => message?.role === 'user');

  const imageSources = userMessages.flatMap((message, index) => collectImageSourcesFromMessage(message, index));
  if (!imageSources.length) return [];

  const attachments = [];
  for (const [index, source] of imageSources.entries()) {
    const attachment = await materializeImageAttachment(source, index);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

function toolMessageContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'input_text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean);
    if (texts.length) return texts.join('\n');

    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return '';
}

function normalizeToolResultMessage(message) {
  const content = toolMessageContentText(message?.content);
  return content.trim() ? content : 'OK';
}

function isSyntheticToolRepairMessage(message) {
  const text = normalizeToolResultMessage(message).toLowerCase();
  return text.includes('missing tool result in session history')
    || text.includes('transcript repair')
    || text.includes('gateway restarted')
    || text.includes('tool result unavailable after restart');
}

function shouldAutoRecoverMissingToolResults() {
  const raw = String(process.env.COPILOT_AUTO_RECOVER_MISSING_TOOL_RESULTS ?? '1').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function buildSyntheticMissingToolResult(pending, message = null) {
  const details = message ? normalizeToolResultMessage(message) : null;
  const payload = {
    ok: false,
    interrupted: true,
    tool: pending?.name ?? 'tool',
    toolCallId: pending?.id ?? null,
    error: 'OpenClaw tool result was unavailable before it could be delivered back to Copilot. This usually means the OpenClaw gateway restarted, repaired session history, or otherwise lost the in-flight tool result.',
    details: details || null,
  };
  return JSON.stringify(payload, null, 2);
}

function shouldRestartSessionAfterSyntheticToolRepair(toolMessages, missingToolCalls) {
  if (!shouldAutoRecoverMissingToolResults()) return false;
  if (!Array.isArray(missingToolCalls) || missingToolCalls.length === 0) return false;
  if (!Array.isArray(toolMessages) || toolMessages.length === 0) return false;
  return toolMessages.some((message) => isSyntheticToolRepairMessage(message));
}

function shouldSilentlyIgnoreStaleToolRepairRequest(messages, toolMessages) {
  if (!Array.isArray(toolMessages) || toolMessages.length === 0) return false;
  if (latestUserMessage(messages).trim()) return false;
  return toolMessages.every((message) => isSyntheticToolRepairMessage(message));
}

function resolveToolCallIdFromMessage(message) {
  const direct = message?.tool_call_id ?? message?.toolCallId ?? message?.tool_use_id ?? message?.toolUseId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return null;
}

function normalizeToolCallIdForMatch(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function describeToolMessageForLog(message) {
  return {
    role: message?.role ?? null,
    type: message?.type ?? null,
    name: message?.name ?? message?.toolName ?? null,
    tool_call_id: message?.tool_call_id ?? null,
    toolCallId: message?.toolCallId ?? null,
    tool_use_id: message?.tool_use_id ?? null,
    toolUseId: message?.toolUseId ?? null,
    contentPreview: previewForLog(message?.content ?? null, 500),
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function toolCallsSnapshot(entry) {
  if (!(entry.pendingToolCalls instanceof Map)) return [];
  return [...entry.pendingToolCalls.values()].map((pending) => ({
    id: pending.id,
    type: OPENAI_FUNCTION_TOOL_TYPE,
    function: {
      name: pending.name,
      arguments: JSON.stringify(pending.arguments ?? {}),
    },
  }));
}

function ensurePendingToolCallState(entry) {
  if (!(entry.pendingToolCalls instanceof Map)) {
    entry.pendingToolCalls = new Map();
  }
  return entry.pendingToolCalls;
}

function schedulePendingToolCallEvent(entry) {
  const turn = entry.activeTurn;
  if (!turn) return;
  if (turn.pendingToolCallEventScheduled) return;

  turn.pendingToolCallEventScheduled = true;
  setTimeout(() => {
    turn.pendingToolCallEventScheduled = false;
    if (!entry.activeTurn || entry.activeTurn.id !== turn.id) return;
    if (!entry.pendingToolCalls?.size) return;
    queueTurnEvent(turn, {
      type: 'tool_calls_required',
    });
  }, 0);
}

function buildCopilotToolsFromOpenAITools(clientTools, entry) {
  return clientTools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    parameters: tool.function.parameters ?? { type: 'object', properties: {} },
    overridesBuiltInTool: true,
    handler: async (args, invocation) => {
      if (!entry.activeTurn) {
        throw new Error(`tool ${tool.function.name} requested with no active turn`);
      }

      const pendingToolCalls = ensurePendingToolCallState(entry);
      if (pendingToolCalls.has(invocation.toolCallId)) {
        throw new Error(`tool ${tool.function.name} is already pending for this turn`);
      }

      const deferred = createDeferred();
      const pending = {
        id: invocation.toolCallId,
        name: tool.function.name,
        arguments: normalizeToolCallArguments(args),
        createdAt: nowMs(),
        resolve: deferred.resolve,
        reject: deferred.reject,
      };

      pendingToolCalls.set(invocation.toolCallId, pending);
      entry.activeTurn.state = 'awaiting_tool_results';
      schedulePendingToolCallEvent(entry);

      try {
        return await deferred.promise;
      } finally {
        if (pendingToolCalls.get(invocation.toolCallId) === pending) {
          pendingToolCalls.delete(invocation.toolCallId);
        }
        if (entry.pendingToolCalls?.size === 0 && entry.activeTurn?.state === 'awaiting_tool_results') {
          entry.activeTurn.state = 'running';
        }
      }
    },
  }));
}

function queueTurnEvent(turn, event) {
  const waiter = turn.waiters.shift();
  if (waiter) {
    waiter.resolve(event);
    return;
  }
  turn.events.push(event);
}

function rejectTurnWaiters(turn, error) {
  while (turn.waiters.length) {
    const waiter = turn.waiters.shift();
    waiter.reject(error);
  }
}

function waitForTurnEvent(turn, timeoutMs = null) {
  if (turn.events.length) {
    return Promise.resolve(turn.events.shift());
  }

  const waiter = createDeferred();
  turn.waiters.push(waiter);

   if (timeoutMs == null || timeoutMs <= 0) {
    return waiter.promise;
  }

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const idx = turn.waiters.indexOf(waiter);
      if (idx >= 0) turn.waiters.splice(idx, 1);
      reject(Object.assign(new Error(`Timeout after ${timeoutMs}ms waiting for turn event`), { code: 'TURN_EVENT_TIMEOUT' }));
    }, timeoutMs);
  });

  return Promise.race([waiter.promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function sendAndWaitNoTimeout(session, options, entry, timeoutMs = DEFAULTS.sendTimeoutMs) {
  let resolveIdle;
  let rejectWithError;
  const idlePromise = new Promise((resolve, reject) => {
    resolveIdle = resolve;
    rejectWithError = reject;
  });

  let turnContent = '';
  const toolNamesById = new Map();
  let sendTimeoutId;
  let rejectSendTimeout;
  let lastTimeoutResetReason = 'send_started';
  const activeTurn = entry.activeTurn;
  const refreshSendTimeout = (reason = 'activity') => {
    if (timeoutMs == null || timeoutMs <= 0) return;
    lastTimeoutResetReason = reason;
    const startedAt = nowMs();
    const deadlineAt = startedAt + timeoutMs;
    if (sendTimeoutId) clearTimeout(sendTimeoutId);
    if (activeTurn) {
      activeTurn.sendTimeoutStartedAt = startedAt;
      activeTurn.sendTimeoutDeadlineAt = deadlineAt;
      activeTurn.sendTimeoutLastResetReason = reason;
    }
    sendTimeoutId = setTimeout(() => {
      const phase = entry.awaitingUserInput ? 'awaiting_user_input' : (entry.activeTurn?.state ?? 'running');
      const error = new Error(`sendAndWait timed out after ${timeoutMs}ms while ${phase} – CLI session may be dead`);
      error.code = 'SEND_TIMEOUT';
      error.phase = phase;
      error.timeoutMs = timeoutMs;
      error.lastTimeoutResetReason = lastTimeoutResetReason;
      rejectSendTimeout?.(error);
    }, timeoutMs);
  };

  if (activeTurn) {
    activeTurn.refreshSendTimeout = refreshSendTimeout;
  }
  const unsubscribe = session.on((event) => {
    if (event.type === 'assistant.message') {
      refreshSendTimeout('assistant_message');
      turnContent = event.data.content ?? '';
      const toolRequests = Array.isArray(event.data.toolRequests) ? event.data.toolRequests : [];
      if (toolRequests.length) {
        for (const request of toolRequests) {
          toolNamesById.set(request.toolCallId, request.name);
          const toolEntry = ensureTurnToolEntry(entry.activeTurn, request.toolCallId, request.name);
          if (toolEntry && request.arguments !== undefined) {
            toolEntry.arguments = request.arguments;
          }
        }
        logProxyEvent('tool_requests', {
          sessionKey: entry.sessionKey,
          sessionId: session.sessionId,
          turnId: entry.activeTurn?.id ?? null,
          toolRequests: toolRequests.map((request) => ({
            toolCallId: request.toolCallId,
            name: request.name,
            argumentsPreview: previewForLog(request.arguments, 800),
          })),
        });
      }
      if (entry.activeTurn) {
        queueTurnEvent(entry.activeTurn, {
          type: 'partial_message',
          content: turnContent,
        });
      }
    } else if (event.type === 'assistant.message_delta') {
      // True streaming: push incremental delta to turn queue for real-time SSE delivery
      const deltaContent = event.data?.deltaContent ?? '';
      if (deltaContent && entry.activeTurn) {
        queueTurnEvent(entry.activeTurn, {
          type: 'stream_delta',
          deltaContent,
        });
      }
    } else if (event.type === 'tool.execution_start') {
      refreshSendTimeout('tool_execution_start');
      toolNamesById.set(event.data.toolCallId, event.data.toolName);
      const toolEntry = ensureTurnToolEntry(entry.activeTurn, event.data.toolCallId, event.data.toolName);
      if (toolEntry && event.data.arguments !== undefined) {
        toolEntry.arguments = event.data.arguments;
      }
      logProxyEvent('tool_start', {
        sessionKey: entry.sessionKey,
        sessionId: session.sessionId,
        turnId: entry.activeTurn?.id ?? null,
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
        argumentsPreview: previewForLog(event.data.arguments, 800),
      });
    } else if (event.type === 'tool.execution_progress') {
      refreshSendTimeout('tool_execution_progress');
      logProxyEvent('tool_progress', {
        sessionKey: entry.sessionKey,
        sessionId: session.sessionId,
        turnId: entry.activeTurn?.id ?? null,
        toolCallId: event.data.toolCallId,
        toolName: toolNamesById.get(event.data.toolCallId) ?? null,
        progressMessage: event.data.progressMessage,
      });
    } else if (event.type === 'tool.execution_partial_result') {
      refreshSendTimeout('tool_execution_partial_result');
      const toolEntry = ensureTurnToolEntry(
        entry.activeTurn,
        event.data.toolCallId,
        toolNamesById.get(event.data.toolCallId) ?? 'tool'
      );
      if (toolEntry) {
        toolEntry.partialOutput = formatToolOutputText(event.data.partialOutput) ?? undefined;
      }
      logProxyEvent('tool_partial', {
        sessionKey: entry.sessionKey,
        sessionId: session.sessionId,
        turnId: entry.activeTurn?.id ?? null,
        toolCallId: event.data.toolCallId,
        toolName: toolNamesById.get(event.data.toolCallId) ?? null,
        partialOutputPreview: previewForLog(event.data.partialOutput, 800),
      });
    } else if (event.type === 'tool.execution_complete') {
      refreshSendTimeout('tool_execution_complete');
      const toolEntry = ensureTurnToolEntry(
        entry.activeTurn,
        event.data.toolCallId,
        toolNamesById.get(event.data.toolCallId) ?? event.data.toolCallId
      );
      if (toolEntry) {
        toolEntry.output = event.data.success
          ? (formatToolOutputText(event.data.result) ?? 'OK')
          : (formatToolOutputText(event.data.error) ?? 'Unknown error');
      }
      logProxyEvent('tool_complete', {
        sessionKey: entry.sessionKey,
        sessionId: session.sessionId,
        turnId: entry.activeTurn?.id ?? null,
        toolCallId: event.data.toolCallId,
        toolName: toolNamesById.get(event.data.toolCallId) ?? null,
        success: event.data.success,
        resultPreview: previewForLog(event.data.result?.content ?? event.data.result?.detailedContent ?? null, 1200),
        errorPreview: previewForLog(event.data.error ?? null, 800),
      });
    } else if (event.type === 'session.idle') {
      resolveIdle();
    } else if (event.type === 'session.error') {
      const error = new Error(event.data.message);
      error.stack = event.data.stack;
      rejectWithError(error);
    }
  });

  const sendTimeoutPromise = timeoutMs > 0
    ? new Promise((_, reject) => {
        rejectSendTimeout = reject;
      })
    : null;

  refreshSendTimeout('send_started');

  try {
    await session.send(options);
    if (sendTimeoutPromise) {
      await Promise.race([idlePromise, sendTimeoutPromise]);
    } else {
      await idlePromise;
    }
    return { data: { content: turnContent } };
  } finally {
    if (sendTimeoutId) clearTimeout(sendTimeoutId);
    if (activeTurn?.refreshSendTimeout === refreshSendTimeout) {
      delete activeTurn.refreshSendTimeout;
      delete activeTurn.sendTimeoutStartedAt;
      delete activeTurn.sendTimeoutDeadlineAt;
      delete activeTurn.sendTimeoutLastResetReason;
    }
    unsubscribe();
  }
}

async function readShutdownMetrics(sessionId) {
  const base = path.join(os.homedir(), '.copilot', 'session-state', sessionId);
  const candidates = [
    path.join(base, 'events.jsonl'),
    path.join(base, 'research', 'events.jsonl'),
  ];

  for (const candidate of candidates) {
    try {
      const text = await fs.readFile(candidate, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const item = JSON.parse(lines[i]);
        if (item.type === 'session.shutdown') {
          return { eventsPath: candidate, shutdown: item.data };
        }
      }
      return { eventsPath: candidate, shutdown: null };
    } catch {
      // continue
    }
  }

  return {
    eventsPath: candidates[0],
    shutdown: null,
    error: 'no shutdown event found in standard locations',
  };
}

function buildResponse({
  model,
  messageContent,
  toolCalls = null,
  metrics,
  sessionId,
  sessionKey,
  finishReason = 'stop',
  status = 'completed',
  pendingUserInput = null,
  entry = null,
}) {
  const modelMetrics = metrics?.shutdown?.modelMetrics?.[model];
  const usage = modelMetrics?.usage ?? {};
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: messageContent ?? null,
          ...(Array.isArray(toolCalls) && toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: status === 'completed' ? (usage.inputTokens ?? 0) : 0,
      completion_tokens: status === 'completed' ? (usage.outputTokens ?? 0) : 0,
      total_tokens: status === 'completed'
        ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        : 0,
    },
    copilot: {
      status,
      sessionId,
      sessionKey,
      totalPremiumRequests: metrics?.shutdown?.totalPremiumRequests ?? null,
      requestsCount: modelMetrics?.requests?.count ?? null,
      cost: modelMetrics?.requests?.cost ?? null,
      eventsPath: metrics?.eventsPath ?? null,
      pendingUserInput,
      pendingToolCalls: entry?.pendingToolCalls?.size ? toolCallsSnapshot(entry) : null,
      turnsCompleted: entry?.turns ?? null,
      sendsStarted: entry?.sendsStarted ?? null,
      activeTurnId: entry?.activeTurn?.id ?? null,
      activeTurnState: entry?.activeTurn?.state ?? null,
    },
  };
}

function buildIgnoredToolRepairResponse({
  model,
  sessionKey,
  ignoredToolCalls = [],
}) {
  const response = buildResponse({
    model,
    messageContent: '',
    metrics: null,
    sessionId: null,
    sessionKey,
    finishReason: 'stop',
    status: 'ignored_stale_tool_results',
    entry: null,
  });
  response.copilot.ignoredToolCalls = ignoredToolCalls;
  return response;
}

async function buildClient(cwd) {
  const client = new CopilotClient({
    cliPath: DEFAULTS.cliPath,
    useStdio: true,
    autoStart: true,
    logLevel: DEFAULTS.logLevel,
    cwd,
    cliArgs: DEFAULTS.cliArgs,
  });
  await client.start();
  return client;
}

function normalizeModelMap(models) {
  return new Map(models.map((m) => [m.id, m]));
}

function getSessionKey(req, body) {
  return getHeaderValue(req, 'x-copilot-session-key')
    || getHeaderValue(req, 'x-openclaw-session-key')
    || body.session_key
    || body.sessionKey
    || null;
}

function getMessageChannel(req, body) {
  return getHeaderValue(req, 'x-openclaw-message-channel')
    || body.message_channel
    || body.messageChannel
    || null;
}

function getOpenClawRouteHint(req) {
  const parts = [
    getHeaderValue(req, 'x-openclaw-account-id'),
    getHeaderValue(req, 'x-openclaw-thread-id'),
    getHeaderValue(req, 'x-openclaw-message-to'),
  ].filter(Boolean);

  if (!parts.length) return null;
  return parts.join(':');
}

function buildDefaultSessionKey(req, messageChannel) {
  const raw = String(process.env.COPILOT_SPLIT_DEFAULT_SESSION_BY_CHANNEL ?? '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) {
    const channel = String(messageChannel || 'default').trim() || 'default';
    return `default-session:${channel}`;
  }
  return 'default-session';
}

function wantsNewSession(req, body) {
  const raw = req.headers['x-copilot-new-session'] ?? body.new_session ?? body.newSession ?? false;
  if (typeof raw === 'boolean') return raw;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).toLowerCase());
}

function findReusablePendingEphemeralSession(sessionMap, model) {
  const candidates = [...sessionMap.values()].filter((entry) => (
    entry.sessionKey?.startsWith('ephemeral:') &&
    entry.model === model &&
    entry.awaitingUserInput &&
    entry.activeTurn?.state === 'awaiting_user_input' &&
    !entry.closing
  ));

  if (candidates.length === 1) {
    return candidates[0];
  }

  return null;
}

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function normalizeReasoningEffort(value) {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (VALID_REASONING_EFFORTS.has(normalized)) return normalized;
  return undefined;
}

function makeSessionConfig(model, cwd, entry, clientTools = [], systemMessageContent = null) {
  const builtInToolNames = Array.isArray(entry.copilotBuiltInToolNames) && entry.copilotBuiltInToolNames.length
    ? entry.copilotBuiltInToolNames
    : DEFAULT_COPILOT_BUILT_IN_TOOLS;
  const config = {
    clientName: 'openclaw-copilot-openai-proxy',
    model,
    onPermissionRequest: approveAll,
    onUserInputRequest: async (request) => {
      if (!entry.activeTurn) {
        throw new Error('ask_user requested with no active turn');
      }

      if (entry.awaitingUserInput) {
        throw new Error('ask_user requested while another ask_user is still pending');
      }

      const deferred = createDeferred();
      const pendingUserInput = {
        question: request.question,
        choices: Array.isArray(request.choices) ? request.choices : [],
        allowFreeform: request.allowFreeform !== false,
        createdAt: nowMs(),
        resolve: deferred.resolve,
        reject: deferred.reject,
      };

      entry.awaitingUserInput = pendingUserInput;
      entry.activeTurn.state = 'awaiting_user_input';
      entry.activeTurn.refreshSendTimeout?.('awaiting_user_input');
      queueTurnEvent(entry.activeTurn, {
        type: 'user_input_required',
        question: pendingUserInput.question,
        choices: pendingUserInput.choices,
        allowFreeform: pendingUserInput.allowFreeform,
        createdAt: pendingUserInput.createdAt,
      });

      try {
        const value = await deferred.promise;
        entry.activeTurn.state = 'running';
        return value;
      } finally {
        if (entry.awaitingUserInput === pendingUserInput) {
          entry.awaitingUserInput = null;
        }
      }
    },
    tools: buildCopilotToolsFromOpenAITools(clientTools, entry),
    excludedTools: buildExcludedCopilotTools(builtInToolNames),
    workingDirectory: cwd,
    streaming: true,
    ...(entry.reasoningEffort != null ? { reasoningEffort: entry.reasoningEffort } : {}),
    ...(systemMessageContent ? { systemMessage: { mode: 'replace', content: systemMessageContent } } : {}),
  };

  return config;
}

function nowMs() {
  return Date.now();
}

function logProxyEvent(kind, payload) {
  console.log(`[proxy:${kind}] ${JSON.stringify(payload)}`);
}

function previewForLog(value, maxLength = 500) {
  if (value == null) return null;

  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function ensureTurnToolState(turn) {
  if (!turn) return null;
  if (!(turn.toolCallsById instanceof Map)) {
    turn.toolCallsById = new Map();
  }
  if (!Array.isArray(turn.toolCallOrder)) {
    turn.toolCallOrder = [];
  }
  return turn;
}

function ensureTurnToolEntry(turn, toolCallId, name = 'tool') {
  const state = ensureTurnToolState(turn);
  if (!state || !toolCallId) return null;

  let entry = state.toolCallsById.get(toolCallId);
  if (!entry) {
    entry = {
      toolCallId,
      name,
      arguments: undefined,
      output: undefined,
      partialOutput: undefined,
    };
    state.toolCallsById.set(toolCallId, entry);
    state.toolCallOrder.push(toolCallId);
  } else if (name && !entry.name) {
    entry.name = name;
  }

  return entry;
}

function formatToolOutputText(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const contentText = Array.isArray(value?.content)
    ? value.content
        .map((item) => (item?.type === 'text' && typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean)
        .join('\n')
    : null;

  if (contentText) return contentText;
  if (typeof value?.content === 'string') return value.content;
  if (typeof value?.detailedContent === 'string') return value.detailedContent;
  if (typeof value?.text === 'string') return value.text;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildAssistantMessageContent(content, turn) {
  const text = String(content ?? '').trim();
  const state = ensureTurnToolState(turn);
  const blocks = [];

  if (text) {
    blocks.push({
      type: 'text',
      text,
    });
  }

  if (state?.toolCallOrder?.length) {
    for (const toolCallId of state.toolCallOrder) {
      const entry = state.toolCallsById.get(toolCallId);
      if (!entry) continue;

      blocks.push({
        type: 'toolcall',
        id: toolCallId,
        name: entry.name || 'tool',
        arguments: entry.arguments ?? {},
      });

      const output = entry.output ?? entry.partialOutput;
      if (output) {
        blocks.push({
          type: 'toolresult',
          name: entry.name || 'tool',
          text: output,
        });
      }
    }
  }

  if (blocks.length === 0) return text;
  if (blocks.length === 1 && blocks[0].type === 'text') return text;
  return blocks;
}

function textPreviewFromAssistantContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item?.type === 'text' && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }

  const client = await buildClient(opts.cwd);
  let modelsCache = await client.listModels();
  let modelMap = normalizeModelMap(modelsCache);
  let modelsCachedAt = nowMs();
  const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
  const sessionMap = new Map();
  const implicitSessionKeyByModel = new Map();
  let copilotBuiltInToolNames = [...DEFAULT_COPILOT_BUILT_IN_TOOLS];

  const refreshModels = async (force = false) => {
    if (!force && (nowMs() - modelsCachedAt) < MODELS_CACHE_TTL_MS) return;
    modelsCache = await client.listModels();
    modelMap = normalizeModelMap(modelsCache);
    modelsCachedAt = nowMs();
  };

  const refreshCopilotBuiltInTools = async () => {
    try {
      const result = await client.rpc.tools.list({});
      const names = normalizeCopilotBuiltInToolNames(result);
      if (names.length) {
        copilotBuiltInToolNames = names;
        logProxyEvent('copilot_builtin_tools', {
          count: names.length,
          names,
          excluded: buildExcludedCopilotTools(names),
        });
      }
    } catch (error) {
      logProxyEvent('copilot_builtin_tools_error', {
        message: error?.message ?? String(error),
        fallbackCount: copilotBuiltInToolNames.length,
        fallbackExcluded: buildExcludedCopilotTools(copilotBuiltInToolNames),
      });
    }
  };

  await refreshCopilotBuiltInTools();

  const touchSession = (entry) => {
    entry.lastUsedAt = nowMs();
    entry.expiresAt = opts.sessionTtlMs > 0 ? entry.lastUsedAt + opts.sessionTtlMs : null;
  };

  const getImplicitSessionKey = (model) => {
    const sessionKey = implicitSessionKeyByModel.get(model);
    if (!sessionKey) return null;
    const entry = sessionMap.get(sessionKey);
    if (!entry || entry.closing || entry.model !== model) {
      implicitSessionKeyByModel.delete(model);
      return null;
    }
    return sessionKey;
  };

  const rememberImplicitSessionKey = (entry) => {
    if (!entry?.model || !entry?.sessionKey || entry.closing) return;
    if (entry.allowImplicitReuse === false) return;
    implicitSessionKeyByModel.set(entry.model, entry.sessionKey);
  };

  const sessionSnapshot = (entry) => ({
    sessionKey: entry.sessionKey,
    sessionId: entry.session.sessionId,
    model: entry.model,
    clientTools: entry.clientTools?.map((tool) => tool.function.name) ?? [],
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    expiresAt: entry.expiresAt,
    turns: entry.turns,
    sendsStarted: entry.sendsStarted,
    pending: entry.pending,
    restartSessionOnNextRequest: entry.restartSessionOnNextRequest === true,
    awaitingUserInput: entry.awaitingUserInput
      ? {
          question: entry.awaitingUserInput.question,
          choices: entry.awaitingUserInput.choices,
          allowFreeform: entry.awaitingUserInput.allowFreeform,
          createdAt: entry.awaitingUserInput.createdAt,
        }
      : null,
    pendingToolCalls: entry.pendingToolCalls?.size
      ? toolCallsSnapshot(entry)
      : null,
    activeTurn: entry.activeTurn
      ? {
          id: entry.activeTurn.id,
          state: entry.activeTurn.state,
          startedAt: entry.activeTurn.startedAt,
          sendTimeoutStartedAt: entry.activeTurn.sendTimeoutStartedAt ?? null,
          sendTimeoutDeadlineAt: entry.activeTurn.sendTimeoutDeadlineAt ?? null,
          sendTimeoutLastResetReason: entry.activeTurn.sendTimeoutLastResetReason ?? null,
          promptPreview: entry.activeTurn.prompt.slice(0, 280),
          queuedEvents: entry.activeTurn.events.length,
        }
      : null,
  });

  const closeSessionEntry = async (entry, reason = 'manual-close') => {
    if (!entry || entry.closing) return;
    entry.closing = true;
    if (entry.awaitingUserInput) {
      try {
        entry.awaitingUserInput.reject(new Error(`Session closed: ${reason}`));
      } catch {
        // ignore
      }
      entry.awaitingUserInput = null;
    }
    if (entry.activeTurn) {
      entry.activeTurn.state = 'closed';
      rejectTurnWaiters(entry.activeTurn, new Error(`Session closed: ${reason}`));
    }
    if (entry.pendingToolCalls?.size) {
      for (const pending of entry.pendingToolCalls.values()) {
        try {
          pending.reject(new Error(`Session closed: ${reason}`));
        } catch {
          // ignore
        }
      }
      entry.pendingToolCalls.clear();
    }
    try {
      await entry.session.disconnect();
    } catch {
      // ignore
    } finally {
      if (entry.sessionKey) {
        sessionMap.delete(entry.sessionKey);
      }
      if (entry.model && implicitSessionKeyByModel.get(entry.model) === entry.sessionKey) {
        implicitSessionKeyByModel.delete(entry.model);
      }
      entry.closedAt = nowMs();
      entry.closeReason = reason;
    }
  };

  const syncSessionTools = async (entry, clientTools = []) => {
    const nextSignature = serializeClientTools(clientTools);
    if (entry.clientToolsSignature === nextSignature) return;
    entry.session.registerTools(buildCopilotToolsFromOpenAITools(clientTools, entry));
    entry.clientTools = clientTools;
    entry.clientToolsSignature = nextSignature;
  };

  const getOrCreateSessionEntry = async (
    sessionKey,
    model,
    forceNew = false,
    systemMessage = null,
    clientTools = [],
    options = {},
  ) => {
    const reasoningEffort = options.reasoningEffort ?? null;
    const existing = sessionKey ? sessionMap.get(sessionKey) : null;
    if (existing && !forceNew && existing.model === model && existing.reasoningEffort === reasoningEffort) {
      if (existing.restartSessionOnNextRequest) {
        logProxyEvent('session_recreate', {
          sessionKey,
          sessionId: existing.session?.sessionId ?? null,
          model,
          reason: existing.restartSessionReason ?? 'restart-on-next-request',
        });
        await closeSessionEntry(existing, existing.restartSessionReason ?? 'restart-on-next-request');
        return getOrCreateSessionEntry(sessionKey, model, true, systemMessage, clientTools, options);  // options includes reasoningEffort
      }
      // Health-check: verify the CLI process is still alive before reusing
      if (!existing.pending) {
        const pingNow = nowMs();
        if (pingNow - (existing.lastPingAt ?? 0) > 30_000) {
          try {
            await client.ping();
            existing.lastPingAt = pingNow;
          } catch (pingErr) {
            logProxyEvent('session_ping_failed', {
              sessionKey,
              sessionId: existing.session?.sessionId ?? null,
              error: pingErr?.message ?? String(pingErr),
            });
            await closeSessionEntry(existing, 'ping-failed');
            // Fall through to create a new session
            return getOrCreateSessionEntry(sessionKey, model, true, systemMessage, clientTools, options);  // options includes reasoningEffort
          }
        }
        await syncSessionTools(existing, clientTools);
      }
      touchSession(existing);
      return existing;
    }

    if (existing) {
      await closeSessionEntry(existing, forceNew ? 'forced-new-session' : 'model-or-reasoning-changed');
    }

    const entry = {
      sessionKey,
      session: null,
      model,
      reasoningEffort,
      allowImplicitReuse: options.allowImplicitReuse !== false,
      copilotBuiltInToolNames,
      createdAt: nowMs(),
      lastUsedAt: nowMs(),
      expiresAt: opts.sessionTtlMs > 0 ? nowMs() + opts.sessionTtlMs : null,
      turns: 0,
      sendsStarted: 0,
      lastPingAt: 0,
      pending: false,
      closing: false,
      restartSessionOnNextRequest: false,
      restartSessionReason: null,
      awaitingUserInput: null,
      pendingToolCalls: new Map(),
      clientTools,
      clientToolsSignature: serializeClientTools(clientTools),
      activeTurn: null,
    };
    // Build session-level system message (append mode) from ASK_USER_PROMPT and injected system message.
    // NOTE: session.send() does NOT support per-turn systemMessage — only session config matters.
    const systemParts = [];
    if (shouldForceAskUser()) systemParts.push(ASK_USER_PROMPT);
    if (systemMessage) systemParts.push(systemMessage);
    const combinedSystemMessage = systemParts.join('\n\n') || null;
    entry.session = await client.createSession(makeSessionConfig(model, opts.cwd, entry, clientTools, combinedSystemMessage));
    if (sessionKey) sessionMap.set(sessionKey, entry);
    rememberImplicitSessionKey(entry);
    return entry;
  };

  const startTurn = (entry, prompt, attachments = []) => {
    const turn = {
      id: crypto.randomUUID(),
      prompt,
      state: 'running',
      startedAt: nowMs(),
      completedAt: null,
      toolCallsById: new Map(),
      toolCallOrder: [],
      events: [],
      waiters: [],
      completionPromise: null,
      pendingToolCallEventScheduled: false,
    };

    entry.activeTurn = turn;
    entry.pending = true;
    entry.sendsStarted += 1;
    touchSession(entry);

    const sendParams = { prompt };
    if (Array.isArray(attachments) && attachments.length) {
      sendParams.attachments = attachments;
    }

    turn.completionPromise = sendAndWaitNoTimeout(entry.session, sendParams, entry, opts.sendTimeoutMs)
      .then((final) => {
        turn.state = 'completed';
        turn.completedAt = nowMs();
        entry.turns += 1;
        entry.pending = false;
        touchSession(entry);
        queueTurnEvent(turn, {
          type: 'final',
          final,
        });
        return final;
      })
      .catch((error) => {
        turn.state = 'failed';
        turn.completedAt = nowMs();
        entry.pending = false;
        if (error?.code === 'SEND_TIMEOUT') {
          entry.restartSessionOnNextRequest = true;
          entry.restartSessionReason = error?.phase === 'awaiting_user_input'
            ? 'awaiting-user-input-timeout'
            : 'send-timeout';
        }
        logProxyEvent('turn_error', {
          sessionKey: entry.sessionKey,
          sessionId: entry.session?.sessionId ?? null,
          turnId: turn.id,
          model: entry.model,
          message: error?.message ?? String(error),
        });
        if (entry.awaitingUserInput) {
          try {
            entry.awaitingUserInput.reject(error);
          } catch {
            // ignore
          }
          entry.awaitingUserInput = null;
        }
        if (entry.pendingToolCalls?.size) {
          for (const pending of entry.pendingToolCalls.values()) {
            try {
              pending.reject(error);
            } catch {
              // ignore
            }
          }
          entry.pendingToolCalls.clear();
        }
        rejectTurnWaiters(turn, error);
        queueTurnEvent(turn, {
          type: 'error',
          error,
        });
        return null;
      });

    return turn;
  };

  const cleanupTimer = opts.sessionTtlMs > 0
    ? setInterval(async () => {
        const now = nowMs();
        const expired = [...sessionMap.values()].filter((entry) => !entry.pending && entry.expiresAt && entry.expiresAt <= now);
        for (const entry of expired) {
          await closeSessionEntry(entry, 'ttl-expired');
        }
      }, Math.max(5_000, Math.min(60_000, Math.floor(opts.sessionTtlMs / 3))))
    : null;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${opts.host}:${opts.port}`}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'copilot-openai-proxy',
          defaultModel: opts.defaultModel,
          cwd: opts.cwd,
          sessionTtlMs: opts.sessionTtlMs,
          sessionTtlEnabled: opts.sessionTtlMs > 0,
          activeSessions: sessionMap.size,
        });
      }

      if (req.method === 'GET' && url.pathname === '/debug/sessions') {
        return sendJson(res, 200, {
          sessions: [...sessionMap.values()].map(sessionSnapshot),
        });
      }

      const closeMatch = url.pathname.match(/^\/debug\/sessions\/([^/]+)$/);
      if ((req.method === 'POST' || req.method === 'DELETE') && closeMatch) {
        const sessionKey = decodeURIComponent(closeMatch[1]);
        const entry = sessionMap.get(sessionKey);
        if (!entry) {
          return sendJson(res, 404, { error: { message: `Unknown session key: ${sessionKey}` } });
        }
        const snapshot = sessionSnapshot(entry);
        await closeSessionEntry(entry, 'manual-close');
        return sendJson(res, 200, { ok: true, closed: snapshot });
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        await refreshModels();
        return sendJson(res, 200, toOpenAIModels(modelsCache));
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJsonBody(req);
        const wantsStream = body.stream === true;

        const messages = Array.isArray(body.messages) ? body.messages : [];
        // DEBUG: log raw user messages to diagnose image attachment issues
        const debugUserMsgs = messages.filter(m => m?.role === 'user');
        if (debugUserMsgs.length) {
          const debugContent = debugUserMsgs.map(m => ({
            contentType: typeof m.content,
            isArray: Array.isArray(m.content),
            contentPreview: JSON.stringify(m.content)?.slice(0, 2000),
          }));
          logProxyEvent('debug_user_messages', { count: debugUserMsgs.length, messages: debugContent });
        }
        const rawClientTools = normalizeOpenAITools(body.tools);
        const clientTools = filterClientToolsForCopilot(rawClientTools);
        const messageChannel = getMessageChannel(req, body);
        const forceAskUser = shouldForceAskUser(messages, clientTools);
        if (!messages.length) {
          return sendJson(res, 400, {
            error: {
              message: 'messages is required',
              type: 'invalid_request_error',
            },
          });
        }

        const pendingSessionKey = getSessionKey(req, body);
        const pendingEntry = pendingSessionKey ? sessionMap.get(pendingSessionKey) : null;
        const model = (pendingEntry?.timeoutFallbackModel && pendingEntry?.restartSessionOnNextRequest)
          ? pendingEntry.timeoutFallbackModel
          : (body.model || opts.defaultModel);
        if (!modelMap.has(model)) {
          await refreshModels(true); // force-refresh on unknown model
        }
        if (!modelMap.has(model)) {
          return sendJson(res, 400, {
            error: {
              message: `Unknown Copilot model: ${model}`,
              type: 'invalid_request_error',
            },
          });
        }

        const requestedSessionKey = getSessionKey(req, body);
        const forceNew = wantsNewSession(req, body) || looksLikeOpenClawNewSessionPrompt(messages);
        const implicitSessionKey = !requestedSessionKey && !forceNew
          ? getImplicitSessionKey(model)
          : null;
        const fallbackPendingEphemeral = !requestedSessionKey && !forceNew
          ? findReusablePendingEphemeralSession(sessionMap, model)
          : null;
        const sessionKey = requestedSessionKey
          || implicitSessionKey
          || fallbackPendingEphemeral?.sessionKey
          || buildDefaultSessionKey(req, messageChannel);

        // When /new is detected, close any lingering implicit session for this model
        // that differs from the resolved sessionKey (e.g. channel-specific default sessions).
        if (forceNew && !requestedSessionKey) {
          const staleImplicitKey = getImplicitSessionKey(model);
          if (staleImplicitKey && staleImplicitKey !== sessionKey) {
            const staleEntry = sessionMap.get(staleImplicitKey);
            if (staleEntry && !staleEntry.closing) {
              logProxyEvent('session_close_stale_implicit', {
                staleSessionKey: staleImplicitKey,
                sessionId: staleEntry.session?.sessionId ?? null,
                newSessionKey: sessionKey,
                reason: 'forced-new-session',
              });
              await closeSessionEntry(staleEntry, 'forced-new-session');
            }
          }
        }
        // Merge system messages: top-level body fields, env var, and role=system entries in messages array
        const topLevelSystemMessage = body.system_message || body.systemMessage || process.env.COPILOT_SYSTEM_MESSAGE || null;
        const messagesSystemContent = extractSystemMessageContent(messages);
        const injectedSystemMessage = [topLevelSystemMessage, messagesSystemContent].filter(Boolean).join('\n\n') || null;
        const reasoningEffort = normalizeReasoningEffort(body.reasoning_effort ?? body.reasoningEffort) ?? null;
        let entry = await getOrCreateSessionEntry(
          sessionKey,
          model,
          forceNew,
          injectedSystemMessage,
          clientTools,
          {
            // Only proxy-selected sessions should become the "implicit current session".
            // Explicit ad-hoc session keys (like manual probes) must not hijack later
            // OpenClaw requests that arrive without a session key.
            allowImplicitReuse: !requestedSessionKey,
            reasoningEffort,
          },
        );
        touchSession(entry);

        let turn = entry.activeTurn;

        if (entry.pendingToolCalls?.size) {
          const toolMessages = latestToolMessages(messages);
          logProxyEvent('tool_results_request', {
            model,
            sessionKey,
            sessionId: entry.session.sessionId,
            pendingToolCalls: toolCallsSnapshot(entry).map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.function.name,
            })),
            incomingToolMessages: toolMessages.map(describeToolMessageForLog),
          });
          if (!toolMessages.length) {
            return sendJson(res, 400, {
              error: {
                message: 'This session is waiting for tool results, but no role=tool messages were found in messages',
                type: 'invalid_request_error',
              },
            });
          }

          const resolvedById = new Map();
          const unnamedToolMessages = [];
          for (const message of toolMessages) {
            const toolCallId = resolveToolCallIdFromMessage(message);
            if (toolCallId) {
              resolvedById.set(toolCallId, message);
              const normalizedToolCallId = normalizeToolCallIdForMatch(toolCallId);
              if (normalizedToolCallId) {
                resolvedById.set(normalizedToolCallId, message);
              }
            } else {
              unnamedToolMessages.push(message);
            }
          }

          const pendingEntries = [...entry.pendingToolCalls.values()];
          const missingToolCalls = [];
          const resolutions = [];
          const singleIncomingToolMessage = toolMessages.length === 1 ? toolMessages[0] : null;

          for (const pending of pendingEntries) {
            const matchedMessage = resolvedById.get(pending.id)
              || resolvedById.get(normalizeToolCallIdForMatch(pending.id))
              || (pendingEntries.length === 1 && unnamedToolMessages.length >= 1 ? unnamedToolMessages[unnamedToolMessages.length - 1] : null)
              || (pendingEntries.length === 1 && singleIncomingToolMessage && isSyntheticToolRepairMessage(singleIncomingToolMessage)
                ? singleIncomingToolMessage
                : null);
            if (!matchedMessage) {
              missingToolCalls.push(pending.id);
              continue;
            }
            resolutions.push([pending, normalizeToolResultMessage(matchedMessage)]);
          }

          if (missingToolCalls.length) {
            if (shouldRestartSessionAfterSyntheticToolRepair(toolMessages, missingToolCalls)) {
              const shouldIgnoreRequest = shouldSilentlyIgnoreStaleToolRepairRequest(messages, toolMessages);
              logProxyEvent('stale_pending_tool_calls_reset', {
                model,
                sessionKey,
                sessionId: entry.session.sessionId,
                staleToolCalls: missingToolCalls,
                repairMessages: toolMessages.map((message) => normalizeToolResultMessage(message)).slice(0, 5),
                ignoredCurrentRequest: shouldIgnoreRequest,
              });
              await closeSessionEntry(entry, 'stale-pending-tool-call-after-gateway-restart');
              if (shouldIgnoreRequest) {
                const response = buildIgnoredToolRepairResponse({
                  model,
                  sessionKey,
                  ignoredToolCalls: missingToolCalls,
                });
                const responseHeaders = {
                  'x-copilot-session-key': sessionKey,
                  'x-copilot-new-session': '1',
                  'x-copilot-ignored-stale-tool-results': '1',
                };
                if (wantsStream) {
                  return sendSseChatCompletion(res, response, responseHeaders);
                }
                return sendJson(res, 200, response, responseHeaders);
              }
              entry = await getOrCreateSessionEntry(sessionKey, model, true, injectedSystemMessage, clientTools);
              touchSession(entry);
              turn = entry.activeTurn;
            } else if (!shouldAutoRecoverMissingToolResults()) {
              return sendJson(res, 400, {
                error: {
                  message: `Missing tool results for pending tool call ids: ${missingToolCalls.join(', ')}`,
                  type: 'invalid_request_error',
                },
              });
            } else {
              const recoveryMessage = singleIncomingToolMessage && isSyntheticToolRepairMessage(singleIncomingToolMessage)
                ? singleIncomingToolMessage
                : null;

              for (const pending of pendingEntries) {
                if (!missingToolCalls.includes(pending.id)) continue;
                entry.pendingToolCalls.delete(pending.id);
                pending.resolve(buildSyntheticMissingToolResult(pending, recoveryMessage));
              }

              logProxyEvent('tool_results_recovered', {
                model,
                sessionKey,
                sessionId: entry.session.sessionId,
                recoveredToolCalls: missingToolCalls,
                recoveryMessage: recoveryMessage ? normalizeToolResultMessage(recoveryMessage) : null,
              });
            }
          }

          if (entry.pendingToolCalls?.size) {
            for (const [pending, result] of resolutions) {
              entry.pendingToolCalls.delete(pending.id);
              pending.resolve(result);
            }
          }
          touchSession(entry);
        }

        if (entry.awaitingUserInput) {
          let userReply = latestUserMessage(messages).trim();

          // Collect any images the user attached with their ask_user reply
          const askUserImageAttachments = await collectCopilotImageAttachments(messages, true);
          if (askUserImageAttachments.length) {
            const imagePaths = askUserImageAttachments.map((att) => att.path).filter(Boolean);
            if (imagePaths.length) {
              const imageHint = imagePaths.length === 1
                ? `\n\n[User attached image: ${imagePaths[0]}]`
                : `\n\n[User attached images:\n${imagePaths.map((p) => `  - ${p}`).join('\n')}]`;
              userReply = userReply ? `${userReply}${imageHint}` : imageHint.trim();
            }
          }

          if (!userReply) {
            return sendJson(res, 400, {
              error: {
                message: 'This session is waiting for ask_user input, but no user reply was found in messages',
                type: 'invalid_request_error',
              },
            });
          }
          const pendingUserInput = entry.awaitingUserInput;
          entry.awaitingUserInput = null;
          entry.activeTurn?.refreshSendTimeout?.('user_input_reply');
          pendingUserInput.resolve(normalizeUserInputReply(userReply, pendingUserInput));
          touchSession(entry);
        } else if (!turn || ['completed', 'failed', 'closed'].includes(turn.state)) {
          const attachments = entry.turns === 0
            ? await collectCopilotImageAttachments(messages, false)
            : await collectCopilotImageAttachments(messages, true);

          let prompt = entry.turns === 0
            ? transcriptFromMessages(messages)
            : latestUserMessage(messages);

          if (!prompt.trim() && attachments.length) {
            prompt = 'Please analyze the attached image(s).';
          }

          if (!prompt.trim() && !attachments.length) {
            if (sessionKey.startsWith('ephemeral:')) {
              await closeSessionEntry(entry, 'empty-prompt');
            }
            return sendJson(res, 400, {
              error: {
                message: 'Could not extract prompt text from messages',
                type: 'invalid_request_error',
              },
            });
          }

          // Channel behavior instruction injected into prompt (per-turn, not session-level)
          const channelBehaviorInstruction = buildChannelBehaviorInstruction(messageChannel);
          if (channelBehaviorInstruction) {
            prompt = `${channelBehaviorInstruction}\n\n${prompt}`;
          }

          logProxyEvent('request', {
            method: req.method,
            path: url.pathname,
            model,
            sessionKey,
            requestedSessionKey,
            sessionId: entry.session.sessionId,
            messageChannel,
            openClawRouteHint: getOpenClawRouteHint(req),
            forceNew,
            openClawNewSessionDetected: looksLikeOpenClawNewSessionPrompt(messages),
            implicitSessionKey,
            reusedPendingEphemeralSession: fallbackPendingEphemeral?.sessionKey ?? null,
            awaitingUserInput: !!entry.awaitingUserInput,
            activeTurnState: entry.activeTurn?.state ?? null,
            sendsStarted: entry.sendsStarted,
            turnsCompleted: entry.turns,
            forceAskUser,
            rawClientTools: rawClientTools.map((tool) => tool.function.name),
            clientTools: clientTools.map((tool) => tool.function.name),
            attachmentCount: attachments.length,
            attachmentNames: attachments.map((attachment) => attachment.displayName ?? path.basename(attachment.path)).slice(0, 20),
            effectiveSystemMessage: null,  // now handled at session-level via systemMessage config
            latestUserMessage: prompt.slice(0, 3000),
          });

          turn = startTurn(entry, prompt, attachments);
        }

        let event = await waitForTurnEvent(entry.activeTurn, opts.turnEventTimeoutMs);
        let accumulatedContent = '';

        // True streaming state — tracks if SSE headers have already been written.
        let sseBase = null;
        const startTrueStreaming = () => {
          if (sseBase) return;
          sseBase = {
            id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
            object: 'chat.completion.chunk',
            created: Math.floor(nowMs() / 1000),
            model,
          };
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'x-copilot-model': model,
            'x-copilot-session-id': entry.session?.sessionId ?? '',
            'x-copilot-session-key': sessionKey,
            'x-copilot-new-session': forceNew ? '1' : '0',
          });
          res.write(`data: ${JSON.stringify({ ...sseBase, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        };

        // Consume stream_delta events (true streaming path)
        if (wantsStream) {
          while (event.type === 'stream_delta') {
            if (!sseBase) startTrueStreaming();
            if (event.deltaContent) {
              res.write(`data: ${JSON.stringify({ ...sseBase, choices: [{ index: 0, delta: { content: event.deltaContent }, finish_reason: null }] })}\n\n`);
            }
            event = await waitForTurnEvent(entry.activeTurn, opts.turnEventTimeoutMs);
          }
        }

        // Buffer partial_message events (non-streaming or streaming fallback)
        while (event.type === 'partial_message') {
          accumulatedContent = event.content;
          event = await waitForTurnEvent(entry.activeTurn, opts.turnEventTimeoutMs);
        }

        const sessionId = entry.session.sessionId;

        if (event.type === 'user_input_required') {
          const renderAskUserAsCompleted = shouldRenderAskUserAsCompleted();
          const pendingUserInput = {
            question: event.question,
            choices: event.choices,
            allowFreeform: event.allowFreeform,
            createdAt: event.createdAt,
          };
          const response = buildResponse({
            model,
            messageContent: buildAssistantMessageContent(prependAskUserLabel(
              (accumulatedContent ? accumulatedContent + '\n\n' : '') + event.question
            ), entry.activeTurn),
            metrics: null,
            sessionId,
            sessionKey,
            status: renderAskUserAsCompleted ? 'completed' : 'awaiting_user_input',
            pendingUserInput: renderAskUserAsCompleted ? null : pendingUserInput,
            entry,
          });

          logProxyEvent('response', {
            model,
            sessionKey,
            sessionId,
            status: renderAskUserAsCompleted ? 'completed' : 'awaiting_user_input',
            sendsStarted: entry.sendsStarted,
            turnsCompleted: entry.turns,
            activeTurnState: entry.activeTurn?.state ?? null,
            question: event.question,
            renderedAsCompleted: renderAskUserAsCompleted,
          });

          const responseHeaders = {
            'x-copilot-model': model,
            'x-copilot-session-id': sessionId,
            'x-copilot-session-key': sessionKey,
            'x-copilot-new-session': forceNew ? '1' : '0',
          };

          if (!renderAskUserAsCompleted) {
            responseHeaders['x-copilot-pending-user-input'] = '1';
          }

          if (wantsStream) {
            if (sseBase) {
              // SSE already started — content was streamed as deltas, just send question + finish
              return flushSseStream(res, sseBase, { extraContent: event.question, finishReason: 'stop' });
            }
            return sendSseChatCompletion(res, response, responseHeaders);
          }

          return sendJson(res, 200, response, responseHeaders);
        }

        if (event.type === 'tool_calls_required') {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const toolCalls = toolCallsSnapshot(entry);
          if (!toolCalls.length) {
            event = await waitForTurnEvent(entry.activeTurn, opts.turnEventTimeoutMs);
            // Stream any additional deltas if SSE already started
            if (wantsStream) {
              while (event.type === 'stream_delta') {
                if (!sseBase) startTrueStreaming();
                if (event.deltaContent) {
                  res.write(`data: ${JSON.stringify({ ...sseBase, choices: [{ index: 0, delta: { content: event.deltaContent }, finish_reason: null }] })}\n\n`);
                }
                event = await waitForTurnEvent(entry.activeTurn, opts.turnEventTimeoutMs);
              }
            }
            while (event.type === 'partial_message') {
              accumulatedContent = event.content;
              event = await waitForTurnEvent(entry.activeTurn, opts.turnEventTimeoutMs);
            }
          } else {
            const response = buildResponse({
              model,
              messageContent: accumulatedContent || null,
              toolCalls,
              metrics: null,
              sessionId,
              sessionKey,
              finishReason: 'tool_calls',
              status: 'awaiting_tool_results',
              entry,
            });

            logProxyEvent('response', {
              model,
              sessionKey,
              sessionId,
              status: 'awaiting_tool_results',
              sendsStarted: entry.sendsStarted,
              turnsCompleted: entry.turns,
              activeTurnState: entry.activeTurn?.state ?? null,
              toolCalls: toolCalls.map((toolCall) => ({
                id: toolCall.id,
                name: toolCall.function.name,
              })),
            });

            const responseHeaders = {
              'x-copilot-model': model,
              'x-copilot-session-id': sessionId,
              'x-copilot-session-key': sessionKey,
              'x-copilot-new-session': forceNew ? '1' : '0',
              'x-copilot-pending-tool-calls': String(toolCalls.length),
            };

            if (wantsStream) {
              if (sseBase) {
                // SSE already started — send tool call deltas + finish
                const toolCallDeltas = toolCalls.map((tc, i) => ({
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
                }));
                return flushSseStream(res, sseBase, { toolCalls: toolCallDeltas, finishReason: 'tool_calls' });
              }
              return sendSseChatCompletion(res, response, responseHeaders);
            }

            return sendJson(res, 200, response, responseHeaders);
          }
        }

        if (event.type === 'error') {
          throw event.error;
        }

        const final = event.final;
        const messageContent = buildAssistantMessageContent(final?.data?.content ?? '', entry.activeTurn);

        if (sessionKey.startsWith('ephemeral:')) {
          await closeSessionEntry(entry, 'ephemeral-complete');
        }

        const metrics = await readShutdownMetrics(sessionId);
        const response = buildResponse({
          model,
          messageContent,
          metrics,
          sessionId,
          sessionKey,
          status: 'completed',
          entry,
        });

        logProxyEvent('response', {
          model,
          sessionKey,
          sessionId,
          status: 'completed',
          sendsStarted: entry.sendsStarted,
          turnsCompleted: entry.turns,
          activeTurnState: entry.activeTurn?.state ?? null,
          contentPreview: textPreviewFromAssistantContent(messageContent).slice(0, 160),
          totalPremiumRequests: response.copilot.totalPremiumRequests,
          requestsCount: response.copilot.requestsCount,
        });

        const responseHeaders = {
          'x-copilot-model': model,
          'x-copilot-session-id': sessionId,
          'x-copilot-session-key': sessionKey,
          'x-copilot-new-session': forceNew ? '1' : '0',
        };

        if (wantsStream) {
          if (sseBase) {
            // SSE already started — content was streamed as deltas, just close the stream
            return flushSseStream(res, sseBase, { finishReason: 'stop' });
          }
          return sendSseChatCompletion(res, response, responseHeaders);
        }

        return sendJson(res, 200, response, responseHeaders);
      }

      return sendJson(res, 404, {
        error: {
          message: `Not found: ${req.method} ${req.url}`,
          type: 'not_found_error',
        },
      });
    } catch (error) {
      const isTimeout = error?.code === 'TURN_EVENT_TIMEOUT' || error?.code === 'SEND_TIMEOUT';

      if (isTimeout) {
        const staleKey = getSessionKey(req, {}) || buildDefaultSessionKey(req, null);
        const staleEntry = sessionMap.get(staleKey);
        if (staleEntry && !staleEntry.closing) {
          staleEntry.restartSessionOnNextRequest = true;
          staleEntry.restartSessionReason = error.code === 'TURN_EVENT_TIMEOUT'
            ? 'turn-event-timeout'
            : 'send-timeout';
          staleEntry.timeoutFallbackModel = opts.timeoutFallbackModel ?? null;
          logProxyEvent('timeout_auto_recovery', {
            sessionKey: staleKey,
            code: error.code,
            phase: error.phase ?? null,
          });
        }

        const recoveryContent = '> ⚠️ 操作超时，会话已自动重置。下次请求将开始新会话，请重新描述任务。';
        const recoveryId = `chatcmpl-recovery-${Date.now()}`;
        const recoveryCreated = Math.floor(Date.now() / 1000);
        const recoveryModel = staleEntry?.model ?? 'unknown';

        // SSE 流已开始：补发恢复 chunk 并关闭流
        if (res.headersSent) {
          const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
          const base = { id: recoveryId, object: 'chat.completion.chunk', created: recoveryCreated, model: recoveryModel };
          res.write(chunk({ ...base, choices: [{ index: 0, delta: { content: recoveryContent }, finish_reason: null }] }));
          res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // 非流：直接返回 200 恢复响应
        return sendJson(res, 200, {
          id: recoveryId,
          object: 'chat.completion',
          created: recoveryCreated,
          model: recoveryModel,
          choices: [{ index: 0, message: { role: 'assistant', content: recoveryContent }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          copilot: { status: 'timeout_recovered', sessionKey: staleKey ?? null, sessionId: null },
        });
      }

      return sendJson(res, 500, {
        error: {
          message: error?.stack || String(error),
          type: 'server_error',
        },
      });
    }
  });

  // Avoid stale keep-alive socket reuse from long-idle OpenClaw provider requests.
  server.keepAliveTimeout = 1_000;
  server.headersTimeout = 5_000;
  // If OpenClaw opens a connection but stalls before sending the full JSON body,
  // fail fast instead of hanging the whole gateway lane for minutes.
  server.requestTimeout = 15_000;
  // Do not kill long-running model/tool turns just because the socket stays open.
  server.timeout = 0;
  server.maxRequestsPerSocket = 1;

  server.listen(opts.port, opts.host, () => {
    console.log(`Copilot OpenAI proxy listening on http://${opts.host}:${opts.port}`);
    console.log(`Default model: ${opts.defaultModel}`);
    console.log(`CWD: ${opts.cwd}`);
    console.log(`Session TTL: ${opts.sessionTtlMs}ms`);
    console.log(`Send timeout: ${opts.sendTimeoutMs}ms`);
  });

  const shutdown = async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    server.close();
    for (const entry of [...sessionMap.values()]) {
      await closeSessionEntry(entry, 'process-shutdown');
    }
    await client.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
