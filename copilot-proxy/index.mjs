#!/usr/bin/env node
// index.mjs — HTTP server, session lifecycle, request routing (main entry point)
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { DEFAULTS, DEFAULT_COPILOT_BUILT_IN_TOOLS, ASK_USER_PROMPT, parseArgs, printUsage, nowMs } from './config.mjs';
import { logProxyEvent, queueTurnEvent, rejectTurnWaiters, waitForTurnEvent } from './events.mjs';
import {
  getHeaderValue, getSessionKey, getMessageChannel, getOpenClawRouteHint,
  buildDefaultSessionKey, wantsNewSession,
  messageTextContent, extractSystemMessageContent, transcriptFromMessages,
  latestUserMessage, latestToolMessages,
  looksLikeOpenClawNewSessionPrompt,
  shouldForceAskUser, shouldRenderAskUserAsCompleted,
  normalizeUserInputReply, prependAskUserLabel,
  buildChannelBehaviorInstruction,
} from './messages.mjs';
import { collectCopilotImageAttachments } from './image.mjs';
import {
  normalizeOpenAITools, filterClientToolsForCopilot, serializeClientTools,
  normalizeCopilotBuiltInToolNames, buildExcludedCopilotTools,
  normalizeToolCallArguments,
  toolCallsSnapshot, ensurePendingToolCallState,
  toolMessageContentText, normalizeToolResultMessage,
  isSyntheticToolRepairMessage,
  shouldSilentlyIgnoreStaleToolRepairRequest,
  resolveToolCallIdFromMessage, normalizeToolCallIdForMatch, describeToolMessageForLog,
  buildAssistantMessageContent, textPreviewFromAssistantContent,
  buildCopilotToolsFromOpenAITools,
} from './tools.mjs';
import { sendWithActivityTimeout, readShutdownMetrics } from './timeout.mjs';
import { recordRequest, recordCompleted, recordTimeout, recordError, getMetricsSnapshot } from './metrics.mjs';
import { initDb, queryLogs, queryLogStats, getDbPath, isDbReady } from './db.mjs';
import {
  buildClient, normalizeModelMap, normalizeReasoningEffort,
  makeSessionConfig, buildResponse, buildIgnoredToolRepairResponse,
} from './session.mjs';

// ── HTTP response helpers ─────────────────────────────────────────────────────
function sendJson(res, status, body, extraHeaders = {}) {
  res.shouldKeepAlive = false;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close', ...extraHeaders });
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
  const base = { id: response.id, object: 'chat.completion.chunk', created: response.created, model: response.model };
  const writeChunk = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

  writeChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  const content = textPreviewFromAssistantContent(response?.choices?.[0]?.message?.content ?? '');
  const toolCalls = Array.isArray(response?.choices?.[0]?.message?.tool_calls)
    ? response.choices[0].message.tool_calls : [];
  if (content) writeChunk({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  if (toolCalls.length) writeChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] });
  writeChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: response?.choices?.[0]?.finish_reason ?? 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

function flushSseStream(res, sseBase, { extraContent = '', toolCalls = [], finishReason = 'stop' } = {}) {
  const writeChunk = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (extraContent) writeChunk({ ...sseBase, choices: [{ index: 0, delta: { content: extraContent }, finish_reason: null }] });
  if (toolCalls.length) writeChunk({ ...sseBase, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] });
  writeChunk({ ...sseBase, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB guard
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' });
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(raw);
}

function toOpenAIModels(models) {
  return {
    object: 'list',
    data: models.map((m) => ({
      id: m.id, object: 'model', created: 0, owned_by: 'copilot',
      name: m.name,
      context_window: m.capabilities?.limits?.max_context_window_tokens,
      max_prompt_tokens: m.capabilities?.limits?.max_prompt_tokens,
      reasoning: m.capabilities?.supports?.reasoningEffort ?? false,
      billing: m.billing ?? null,
    })),
  };
}

// ── findReusablePendingEphemeralSession ───────────────────────────────────────
function findReusablePendingEphemeralSession(sessionMap, model) {
  const candidates = [...sessionMap.values()].filter((entry) => (
    entry.sessionKey?.startsWith('ephemeral:') &&
    entry.model === model &&
    entry.awaitingUserInput &&
    entry.activeTurn?.state === 'awaiting_user_input' &&
    !entry.closing
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

// ── Session snapshot ──────────────────────────────────────────────────────────
function sessionSnapshot(entry) {
  return {
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
    pendingToolCalls: entry.pendingToolCalls?.size ? toolCallsSnapshot(entry) : null,
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
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); return; }
  opts.timeoutFallbackModel = DEFAULTS.timeoutFallbackModel;
  // turnEventTimeoutMs is resolved by parseArgs (default: DEFAULTS.turnEventTimeoutMs)

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
        logProxyEvent('copilot_builtin_tools', { count: names.length, names, excluded: buildExcludedCopilotTools(names) });
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
    if (!entry || entry.closing || entry.model !== model) { implicitSessionKeyByModel.delete(model); return null; }
    return sessionKey;
  };

  const rememberImplicitSessionKey = (entry) => {
    if (!entry?.model || !entry?.sessionKey || entry.closing) return;
    if (entry.allowImplicitReuse === false) return;
    implicitSessionKeyByModel.set(entry.model, entry.sessionKey);
  };

  const closeSessionEntry = async (entry, reason = 'manual-close') => {
    if (!entry || entry.closing) return;
    entry.closing = true;
    if (entry.awaitingUserInput) {
      try { entry.awaitingUserInput.reject(new Error(`Session closed: ${reason}`)); } catch { /* ignore */ }
      entry.awaitingUserInput = null;
    }
    if (entry.activeTurn) {
      entry.activeTurn.state = 'closed';
      rejectTurnWaiters(entry.activeTurn, new Error(`Session closed: ${reason}`));
    }
    if (entry.pendingToolCalls?.size) {
      for (const pending of entry.pendingToolCalls.values()) {
        try { pending.reject(new Error(`Session closed: ${reason}`)); } catch { /* ignore */ }
      }
      entry.pendingToolCalls.clear();
    }
    try { await entry.session.disconnect(); } catch { /* ignore */ }
    finally {
      if (entry.sessionKey) sessionMap.delete(entry.sessionKey);
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
    sessionKey, model, forceNew = false, systemMessage = null, clientTools = [], options = {},
  ) => {
    const reasoningEffort = options.reasoningEffort ?? null;
    const existing = sessionKey ? sessionMap.get(sessionKey) : null;
    if (existing && !forceNew && existing.model === model && existing.reasoningEffort === reasoningEffort) {
      if (existing.restartSessionOnNextRequest) {
        logProxyEvent('session_recreate', {
          sessionKey, sessionId: existing.session?.sessionId ?? null, model,
          reason: existing.restartSessionReason ?? 'restart-on-next-request',
        });
        await closeSessionEntry(existing, existing.restartSessionReason ?? 'restart-on-next-request');
        return getOrCreateSessionEntry(sessionKey, model, true, systemMessage, clientTools, options);
      }
      if (!existing.pending) {
        const pingNow = nowMs();
        if (pingNow - (existing.lastPingAt ?? 0) > 30_000) {
          try {
            await client.ping();
            existing.lastPingAt = pingNow;
          } catch (pingErr) {
            logProxyEvent('session_ping_failed', {
              sessionKey, sessionId: existing.session?.sessionId ?? null, error: pingErr?.message ?? String(pingErr),
            });
            await closeSessionEntry(existing, 'ping-failed');
            return getOrCreateSessionEntry(sessionKey, model, true, systemMessage, clientTools, options);
          }
        }
        await syncSessionTools(existing, clientTools);
      }
      touchSession(existing);
      return existing;
    }

    if (existing) await closeSessionEntry(existing, forceNew ? 'forced-new-session' : 'model-or-reasoning-changed');

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
    if (Array.isArray(attachments) && attachments.length) sendParams.attachments = attachments;

    turn.completionPromise = sendWithActivityTimeout(entry.session, sendParams, entry, opts.sendTimeoutMs)
      .then((final) => {
        turn.state = 'completed';
        turn.completedAt = nowMs();
        entry.turns += 1;
        entry.pending = false;
        touchSession(entry);
        queueTurnEvent(turn, { type: 'final', final });
        return final;
      })
      .catch((error) => {
        turn.state = 'failed';
        turn.completedAt = nowMs();
        entry.pending = false;
        if (error?.code === 'SEND_TIMEOUT') {
          entry.restartSessionOnNextRequest = true;
          entry.restartSessionReason = error?.phase === 'awaiting_user_input'
            ? 'awaiting-user-input-timeout' : 'send-timeout';
        }
        logProxyEvent('turn_error', {
          sessionKey: entry.sessionKey, sessionId: entry.session?.sessionId ?? null,
          turnId: turn.id, model: entry.model, message: error?.message ?? String(error),
        });
        if (entry.awaitingUserInput) {
          try { entry.awaitingUserInput.reject(error); } catch { /* ignore */ }
          entry.awaitingUserInput = null;
        }
        if (entry.pendingToolCalls?.size) {
          for (const pending of entry.pendingToolCalls.values()) {
            try { pending.reject(error); } catch { /* ignore */ }
          }
          entry.pendingToolCalls.clear();
        }
        rejectTurnWaiters(turn, error);
        queueTurnEvent(turn, { type: 'error', error });
        return null;
      });

    return turn;
  };

  const cleanupTimer = opts.sessionTtlMs > 0
    ? setInterval(async () => {
        const now = nowMs();
        const expired = [...sessionMap.values()].filter(
          (entry) => !entry.pending && entry.expiresAt && entry.expiresAt <= now,
        );
        for (const entry of expired) await closeSessionEntry(entry, 'ttl-expired');
      }, Math.max(5_000, Math.min(60_000, Math.floor(opts.sessionTtlMs / 3))))
    : null;

  // ── HTTP server ─────────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    let reqModel = null;
    let reqStartedAt = 0;
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${opts.host}:${opts.port}`}`);

      // GET /health
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true, service: 'copilot-openai-proxy', defaultModel: opts.defaultModel,
          cwd: opts.cwd, sessionTtlMs: opts.sessionTtlMs, sessionTtlEnabled: opts.sessionTtlMs > 0,
          activeSessions: sessionMap.size,
        });
      }

      // GET /debug/sessions
      if (req.method === 'GET' && url.pathname === '/debug/sessions') {
        return sendJson(res, 200, { sessions: [...sessionMap.values()].map(sessionSnapshot) });
      }

      // POST/DELETE /debug/sessions/:key
      const closeMatch = url.pathname.match(/^\/debug\/sessions\/([^/]+)$/);
      if ((req.method === 'POST' || req.method === 'DELETE') && closeMatch) {
        const key = decodeURIComponent(closeMatch[1]);
        const entry = sessionMap.get(key);
        if (!entry) return sendJson(res, 404, { error: { message: `Unknown session key: ${key}` } });
        const snapshot = sessionSnapshot(entry);
        await closeSessionEntry(entry, 'manual-close');
        return sendJson(res, 200, { ok: true, closed: snapshot });
      }

      // GET /metrics
      if (req.method === 'GET' && url.pathname === '/metrics') {
        return sendJson(res, 200, getMetricsSnapshot(sessionMap));
      }

      // GET /v1/logs — query persistent SQLite request log
      // query params: limit (default 100, max 500), model, status, since (epoch ms)
      if (req.method === 'GET' && url.pathname === '/v1/logs') {
        const rows = queryLogs({
          limit:  url.searchParams.get('limit')  ?? 100,
          model:  url.searchParams.get('model')  ?? null,
          status: url.searchParams.get('status') ?? null,
          since:  url.searchParams.get('since')  ?? null,
        });
        return sendJson(res, 200, { ok: true, dbReady: isDbReady(), dbPath: getDbPath(), count: rows.length, rows });
      }

      // GET /v1/logs/stats — summary stats grouped by model (last N days)
      if (req.method === 'GET' && url.pathname === '/v1/logs/stats') {
        const days = Number(url.searchParams.get('days') ?? 7);
        const stats = queryLogStats({ days });
        return sendJson(res, 200, { ok: true, dbReady: isDbReady(), days, stats });
      }

      // GET /v1/models
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        await refreshModels();
        return sendJson(res, 200, toOpenAIModels(modelsCache));
      }

      // POST /v1/chat/completions
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJsonBody(req);
        // ── silent-retry loop (max 1 retry on timeout before headers sent) ─
        for (let retryCount = 0; retryCount <= 1; retryCount++) {
        try { // silent-retry try
        const wantsStream = body.stream === true;
        const messages = Array.isArray(body.messages) ? body.messages : [];

        const rawClientTools = normalizeOpenAITools(body.tools);
        const clientTools = filterClientToolsForCopilot(rawClientTools);
        const messageChannel = getMessageChannel(req, body);
        const forceAskUser = shouldForceAskUser(messages, clientTools);

        if (!messages.length) {
          return sendJson(res, 400, { error: { message: 'messages is required', type: 'invalid_request_error' } });
        }

        const pendingSessionKey = getSessionKey(req, body);
        const pendingEntry = pendingSessionKey ? sessionMap.get(pendingSessionKey) : null;
        const model = (pendingEntry?.timeoutFallbackModel && pendingEntry?.restartSessionOnNextRequest)
          ? pendingEntry.timeoutFallbackModel
          : (body.model || opts.defaultModel);

        reqModel = model;
        reqStartedAt = nowMs();
        recordRequest(model);

        if (!modelMap.has(model)) await refreshModels(true);
        if (!modelMap.has(model)) {
          return sendJson(res, 400, { error: { message: `Unknown Copilot model: ${model}`, type: 'invalid_request_error' } });
        }

        const requestedSessionKey = getSessionKey(req, body);
        const forceNew = wantsNewSession(req, body) || looksLikeOpenClawNewSessionPrompt(messages);
        const implicitSessionKey = !requestedSessionKey && !forceNew ? getImplicitSessionKey(model) : null;
        const fallbackPendingEphemeral = !requestedSessionKey && !forceNew
          ? findReusablePendingEphemeralSession(sessionMap, model) : null;
        const sessionKey = requestedSessionKey || implicitSessionKey
          || fallbackPendingEphemeral?.sessionKey || buildDefaultSessionKey(req, messageChannel);

        if (forceNew && !requestedSessionKey) {
          const staleImplicitKey = getImplicitSessionKey(model);
          if (staleImplicitKey && staleImplicitKey !== sessionKey) {
            const staleEntry = sessionMap.get(staleImplicitKey);
            if (staleEntry && !staleEntry.closing) {
              logProxyEvent('session_close_stale_implicit', {
                staleSessionKey: staleImplicitKey, sessionId: staleEntry.session?.sessionId ?? null,
                newSessionKey: sessionKey, reason: 'forced-new-session',
              });
              await closeSessionEntry(staleEntry, 'forced-new-session');
            }
          }
        }

        const topLevelSystemMessage = body.system_message || body.systemMessage || process.env.COPILOT_SYSTEM_MESSAGE || null;
        const messagesSystemContent = extractSystemMessageContent(messages);
        const injectedSystemMessage = [topLevelSystemMessage, messagesSystemContent].filter(Boolean).join('\n\n') || null;
        const reasoningEffort = normalizeReasoningEffort(body.reasoning_effort ?? body.reasoningEffort) ?? null;

        let entry = await getOrCreateSessionEntry(
          sessionKey, model, forceNew, injectedSystemMessage, clientTools,
          { allowImplicitReuse: !requestedSessionKey, reasoningEffort },
        );
        touchSession(entry);

        let turn = entry.activeTurn;

        // ── Tool results path ──────────────────────────────────────────────
        if (entry.pendingToolCalls?.size) {
          const toolMessages = latestToolMessages(messages);
          logProxyEvent('tool_results_request', {
            model, sessionKey, sessionId: entry.session.sessionId,
            pendingToolCalls: toolCallsSnapshot(entry).map((tc) => ({ id: tc.id, name: tc.function.name })),
            incomingToolMessages: toolMessages.map(describeToolMessageForLog),
          });
          if (!toolMessages.length) {
            return sendJson(res, 400, {
              error: { message: 'This session is waiting for tool results, but no role=tool messages were found in messages', type: 'invalid_request_error' },
            });
          }

          const resolvedById = new Map();
          const unnamedToolMessages = [];
          for (const message of toolMessages) {
            const toolCallId = resolveToolCallIdFromMessage(message);
            if (toolCallId) {
              resolvedById.set(toolCallId, message);
              const normalized = normalizeToolCallIdForMatch(toolCallId);
              if (normalized) resolvedById.set(normalized, message);
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
              || (pendingEntries.length === 1 && unnamedToolMessages.length >= 1
                ? unnamedToolMessages[unnamedToolMessages.length - 1]
                : null)
              || (pendingEntries.length === 1 && singleIncomingToolMessage && isSyntheticToolRepairMessage(singleIncomingToolMessage)
                ? singleIncomingToolMessage : null);
            if (!matchedMessage) { missingToolCalls.push(pending.id); continue; }
            resolutions.push([pending, normalizeToolResultMessage(matchedMessage)]);
          }

          if (missingToolCalls.length) {
            const hasSyntheticRepair = toolMessages.some((message) => isSyntheticToolRepairMessage(message));
            const shouldIgnoreRequest = hasSyntheticRepair
              && shouldSilentlyIgnoreStaleToolRepairRequest(messages, toolMessages);

            logProxyEvent('stale_pending_tool_calls_reset', {
              model, sessionKey, sessionId: entry.session.sessionId,
              staleToolCalls: missingToolCalls,
              repairMessages: toolMessages.map((m) => normalizeToolResultMessage(m)).slice(0, 5),
              ignoredCurrentRequest: shouldIgnoreRequest,
              syntheticRepairDetected: hasSyntheticRepair,
              autoReplayDisabled: true,
            });

            await closeSessionEntry(
              entry,
              hasSyntheticRepair
                ? 'stale-pending-tool-call-after-gateway-restart'
                : 'missing-tool-results-no-auto-replay',
            );

            if (shouldIgnoreRequest) {
              const response = buildIgnoredToolRepairResponse({ model, sessionKey, ignoredToolCalls: missingToolCalls });
              const responseHeaders = {
                'x-copilot-session-key': sessionKey,
                'x-copilot-new-session': '1',
                'x-copilot-ignored-stale-tool-results': '1',
              };
              return wantsStream
                ? sendSseChatCompletion(res, response, responseHeaders)
                : sendJson(res, 200, response, responseHeaders);
            }

            const staleMessages = [
              '> 😵 哎，上一轮没跑完就断了，人家都没尽兴呢……会话重置了，再来一次？',
              '> 💨 请求到一半就飞了，搞得我空欢喜一场，帮你清了，重新发嘛~',
              '> 🔄 刚才没落地，我还等着呢……会话重置了，再喂我一遍？',
              '> 😮‍💨 溜了……跑路跑得真快，会话重置完毕，重发一下，别让我空等~',
              '> 🥵 上一轮跑到一半就断了，这也太不负责任了……重置好了，再来？',
              '> 😩 没跑完就没了，我都准备好了结果扑了个空，重置完毕，再说一遍吧~',
            ];
            const freshMessages = [
              '> 🤔 工具结果没送到，人家等了半天什么都没收到……已重置，再说一遍？',
              '> 📭 工具跑完了但结果没寄到，像极了放鸽子，已重置，重发一下~',
              '> 💔 结果丢了，不是我不想要，是真没收到！已重置，重来一次？',
              '> 🫠 收不到工具结果，急死我了……只好重置，再说一次好不好~',
              '> 😤 工具那边做完了，这边一点都没来，气死！已重置，重新来？',
              '> 🥺 等了好久结果什么都没收到，委屈……已重置，再喂我一遍嘛~',
            ];
            const pool = hasSyntheticRepair ? staleMessages : freshMessages;
            const recoveryContent = pool[Math.floor(Math.random() * pool.length)];
            const recoveryId = `chatcmpl-tool-recovery-${Date.now()}`;
            const recoveryCreated = Math.floor(Date.now() / 1000);
            const responseHeaders = {
              'x-copilot-session-key': sessionKey,
              'x-copilot-new-session': '1',
              'x-copilot-tool-recovery': 'manual-retry-required',
            };
            const response = {
              id: recoveryId,
              object: 'chat.completion',
              created: recoveryCreated,
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: recoveryContent }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              copilot: {
                status: 'tool_result_recovery_blocked',
                sessionKey,
                sessionId: null,
                missingToolCalls,
                autoReplayDisabled: true,
              },
            };
            return wantsStream
              ? sendSseChatCompletion(res, response, responseHeaders)
              : sendJson(res, 200, response, responseHeaders);
          }

          if (entry.pendingToolCalls?.size) {
            for (const [pending, result] of resolutions) {
              entry.pendingToolCalls.delete(pending.id);
              pending.resolve(result);
            }
          }
          touchSession(entry);
        }

        // ── ask_user reply path ────────────────────────────────────────────
        if (entry.awaitingUserInput) {
          let userReply = latestUserMessage(messages).trim();
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
              error: { message: 'This session is waiting for ask_user input, but no user reply was found in messages', type: 'invalid_request_error' },
            });
          }
          const pendingUserInput = entry.awaitingUserInput;
          entry.awaitingUserInput = null;
          entry.activeTurn?.refreshSendTimeout?.('user_input_reply');
          pendingUserInput.resolve(normalizeUserInputReply(userReply, pendingUserInput));
          touchSession(entry);
        } else if (!turn || ['completed', 'failed', 'closed'].includes(turn.state)) {
          // ── New turn path ────────────────────────────────────────────────
          const attachments = entry.turns === 0
            ? await collectCopilotImageAttachments(messages, false)
            : await collectCopilotImageAttachments(messages, true);

          let prompt = entry.turns === 0
            ? transcriptFromMessages(messages)
            : latestUserMessage(messages);

          if (!prompt.trim() && attachments.length) prompt = 'Please analyze the attached image(s).';
          if (!prompt.trim() && !attachments.length) {
            if (sessionKey.startsWith('ephemeral:')) await closeSessionEntry(entry, 'empty-prompt');
            return sendJson(res, 400, { error: { message: 'Could not extract prompt text from messages', type: 'invalid_request_error' } });
          }

          const channelBehaviorInstruction = buildChannelBehaviorInstruction(messageChannel);
          if (channelBehaviorInstruction) prompt = `${channelBehaviorInstruction}\n\n${prompt}`;

          logProxyEvent('request', {
            method: req.method, path: url.pathname, model, sessionKey, requestedSessionKey,
            sessionId: entry.session.sessionId, messageChannel,
            openClawRouteHint: getOpenClawRouteHint(req), forceNew,
            openClawNewSessionDetected: looksLikeOpenClawNewSessionPrompt(messages),
            implicitSessionKey, reusedPendingEphemeralSession: fallbackPendingEphemeral?.sessionKey ?? null,
            awaitingUserInput: !!entry.awaitingUserInput, activeTurnState: entry.activeTurn?.state ?? null,
            sendsStarted: entry.sendsStarted, turnsCompleted: entry.turns, forceAskUser,
            rawClientTools: rawClientTools.map((tool) => tool.function.name),
            clientTools: clientTools.map((tool) => tool.function.name),
            attachmentCount: attachments.length,
            attachmentNames: attachments.map((a) => a.displayName ?? path.basename(a.path)).slice(0, 20),
            effectiveSystemMessage: null,
            latestUserMessage: prompt.slice(0, 3000),
          });

          turn = startTurn(entry, prompt, attachments);
        }

        // ── Event loop ───────────────────────────────────────────────────
        // nextEvent: transparently skip tool_activity heartbeat events,
        // re-awaiting each time so the turnEventTimeout is refreshed during tool execution.
        const nextEvent = async () => {
          let ev = await waitForTurnEvent(entry.activeTurn, opts.turnEventTimeoutMs);
          while (ev.type === 'tool_activity') {
            ev = await waitForTurnEvent(entry.activeTurn, opts.turnEventTimeoutMs);
          }
          return ev;
        };
        let event = await nextEvent();
        let accumulatedContent = '';
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

        if (wantsStream) {
          while (event.type === 'stream_delta') {
            if (!sseBase) startTrueStreaming();
            if (event.deltaContent) {
              res.write(`data: ${JSON.stringify({ ...sseBase, choices: [{ index: 0, delta: { content: event.deltaContent }, finish_reason: null }] })}\n\n`);
            }
            event = await nextEvent();
          }
        }

        while (event.type === 'partial_message') {
          accumulatedContent = event.content;
          event = await nextEvent();
        }

        const sessionId = entry.session.sessionId;
        const responseHeaders = {
          'x-copilot-model': model,
          'x-copilot-session-id': sessionId,
          'x-copilot-session-key': sessionKey,
          'x-copilot-new-session': forceNew ? '1' : '0',
        };

        if (event.type === 'user_input_required') {
          const renderAskUserAsCompleted = shouldRenderAskUserAsCompleted();
          const pendingUserInput = {
            question: event.question, choices: event.choices,
            allowFreeform: event.allowFreeform, createdAt: event.createdAt,
          };
          const response = buildResponse({
            model,
            messageContent: buildAssistantMessageContent(
              prependAskUserLabel((accumulatedContent ? accumulatedContent + '\n\n' : '') + event.question),
              entry.activeTurn,
            ),
            metrics: null, sessionId, sessionKey,
            status: renderAskUserAsCompleted ? 'completed' : 'awaiting_user_input',
            pendingUserInput: renderAskUserAsCompleted ? null : pendingUserInput,
            entry,
          });
          logProxyEvent('response', {
            model, sessionKey, sessionId,
            status: renderAskUserAsCompleted ? 'completed' : 'awaiting_user_input',
            sendsStarted: entry.sendsStarted, turnsCompleted: entry.turns,
            activeTurnState: entry.activeTurn?.state ?? null,
            question: event.question, renderedAsCompleted: renderAskUserAsCompleted,
          });
          if (!renderAskUserAsCompleted) responseHeaders['x-copilot-pending-user-input'] = '1';
          if (wantsStream) {
            if (sseBase) return flushSseStream(res, sseBase, { extraContent: event.question, finishReason: 'stop' });
            return sendSseChatCompletion(res, response, responseHeaders);
          }
          return sendJson(res, 200, response, responseHeaders);
        }

        if (event.type === 'tool_calls_required') {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const toolCalls = toolCallsSnapshot(entry);
          if (!toolCalls.length) {
            event = await nextEvent();
            if (wantsStream) {
              while (event.type === 'stream_delta') {
                if (!sseBase) startTrueStreaming();
                if (event.deltaContent) {
                  res.write(`data: ${JSON.stringify({ ...sseBase, choices: [{ index: 0, delta: { content: event.deltaContent }, finish_reason: null }] })}\n\n`);
                }
                event = await nextEvent();
              }
            }
            while (event.type === 'partial_message') {
              accumulatedContent = event.content;
              event = await nextEvent();
            }
          } else {
            const response = buildResponse({
              model, messageContent: accumulatedContent || null, toolCalls, metrics: null,
              sessionId, sessionKey, finishReason: 'tool_calls', status: 'awaiting_tool_results', entry,
            });
            logProxyEvent('response', {
              model, sessionKey, sessionId, status: 'awaiting_tool_results',
              sendsStarted: entry.sendsStarted, turnsCompleted: entry.turns,
              activeTurnState: entry.activeTurn?.state ?? null,
              toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name })),
            });
            responseHeaders['x-copilot-pending-tool-calls'] = String(toolCalls.length);
            if (wantsStream) {
              if (sseBase) {
                const toolCallDeltas = toolCalls.map((tc, i) => ({
                  index: i, id: tc.id, type: 'function',
                  function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
                }));
                return flushSseStream(res, sseBase, { toolCalls: toolCallDeltas, finishReason: 'tool_calls' });
              }
              return sendSseChatCompletion(res, response, responseHeaders);
            }
            return sendJson(res, 200, response, responseHeaders);
          }
        }

        if (event.type === 'error') throw event.error;

        const final = event.final;
        const messageContent = buildAssistantMessageContent(final?.data?.content ?? '', entry.activeTurn);

        if (sessionKey.startsWith('ephemeral:')) await closeSessionEntry(entry, 'ephemeral-complete');

        const metrics = await readShutdownMetrics(sessionId);
        const liveUsage = {
          outputTokens: final?.data?.outputTokens ?? 0,
        };
        const response = buildResponse({
          model,
          messageContent,
          metrics,
          liveUsage,
          sessionId,
          sessionKey,
          status: 'completed',
          entry,
        });
        const latencyMs = nowMs() - reqStartedAt;

        logProxyEvent('response', {
          model, sessionKey, sessionId, status: 'completed',
          latencyMs,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          sendsStarted: entry.sendsStarted, turnsCompleted: entry.turns,
          activeTurnState: entry.activeTurn?.state ?? null,
          contentPreview: textPreviewFromAssistantContent(messageContent).slice(0, 160),
          totalPremiumRequests: response.copilot.totalPremiumRequests,
          requestsCount: response.copilot.requestsCount,
        });
        recordCompleted(model, latencyMs);

        if (wantsStream) {
          if (sseBase) return flushSseStream(res, sseBase, { finishReason: 'stop' });
          return sendSseChatCompletion(res, response, responseHeaders);
        }
        return sendJson(res, 200, response, responseHeaders);
        } catch (_re) { // silent-retry catch
          const _isTimeout = _re?.code === 'TURN_EVENT_TIMEOUT' || _re?.code === 'SEND_TIMEOUT';
          const _safeToRetry = _isTimeout
            && !res.headersSent
            && retryCount < 1
            && _re?.didReachCopilot !== true;
          if (_safeToRetry) {
            recordTimeout(reqModel ?? 'unknown');
            const _staleKey = getSessionKey(req, body) || buildDefaultSessionKey(req, null);
            const _staleEntry = sessionMap.get(_staleKey);
            if (_staleEntry && !_staleEntry.closing) {
              await closeSessionEntry(_staleEntry, 'silent-retry-no-upstream-activity');
            }
            logProxyEvent('silent_retry', {
              sessionKey: _staleKey,
              attempt: retryCount + 1,
              code: _re.code,
              phase: _re.phase ?? null,
              model: reqModel ?? null,
              didReachCopilot: _re?.didReachCopilot ?? false,
              requestId: _re?.requestId ?? null,
            });
            reqModel = null;
            reqStartedAt = 0;
            continue; // retry with fresh session
          }
          throw _re; // bubble to outer catch
        } } // end silent-retry loop
      }

      return sendJson(res, 404, { error: { message: `Not found: ${req.method} ${req.url}`, type: 'not_found_error' } });

    } catch (error) {
      const isTimeout = error?.code === 'TURN_EVENT_TIMEOUT' || error?.code === 'SEND_TIMEOUT';

      if (isTimeout) {
        recordTimeout(reqModel ?? 'unknown');
        const staleKey = getSessionKey(req, {}) || buildDefaultSessionKey(req, null);
        const staleEntry = sessionMap.get(staleKey);
        if (staleEntry && !staleEntry.closing) {
          staleEntry.restartSessionOnNextRequest = true;
          staleEntry.restartSessionReason = error.code === 'TURN_EVENT_TIMEOUT' ? 'turn-event-timeout' : 'send-timeout';
          staleEntry.timeoutFallbackModel = opts.timeoutFallbackModel ?? null;
          logProxyEvent('timeout_auto_recovery', { sessionKey: staleKey, code: error.code, phase: error.phase ?? null });
        }

        const recoveryContent = '> ⚠️ 操作超时，会话已自动重置。下次请求将开始新会话，请重新描述任务。';
        const recoveryId = `chatcmpl-recovery-${Date.now()}`;
        const recoveryCreated = Math.floor(Date.now() / 1000);
        const recoveryModel = staleEntry?.model ?? 'unknown';

        if (res.headersSent) {
          const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
          const base = { id: recoveryId, object: 'chat.completion.chunk', created: recoveryCreated, model: recoveryModel };
          res.write(chunk({ ...base, choices: [{ index: 0, delta: { content: recoveryContent }, finish_reason: null }] }));
          res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        return sendJson(res, 200, {
          id: recoveryId, object: 'chat.completion', created: recoveryCreated, model: recoveryModel,
          choices: [{ index: 0, message: { role: 'assistant', content: recoveryContent }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          copilot: { status: 'timeout_recovered', sessionKey: staleKey ?? null, sessionId: null },
        });
      }

      recordError(reqModel ?? 'unknown');
      if (error?.code === 'BODY_TOO_LARGE') {
        return sendJson(res, 413, { error: { message: 'Request body exceeds 10 MB limit', type: 'invalid_request_error' } });
      }
      return sendJson(res, 500, { error: { message: error?.stack || String(error), type: 'server_error' } });
    }
  });

  server.keepAliveTimeout = 1_000;
  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.timeout = 0;
  server.maxRequestsPerSocket = 1;

  // Initialize SQLite persistent request log
  initDb();

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
    for (const entry of [...sessionMap.values()]) await closeSessionEntry(entry, 'process-shutdown');
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
