// timeout.mjs — sendAndWaitNoTimeout + readShutdownMetrics
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './config.mjs';
import { nowMs } from './config.mjs';
import { logProxyEvent, previewForLog, queueTurnEvent } from './events.mjs';
import { ensureTurnToolEntry, formatToolOutputText } from './tools.mjs';

// NOTE: despite the old name, this function DOES have a timeout (per-activity reset).
export async function sendWithActivityTimeout(session, options, entry, timeoutMs = DEFAULTS.sendTimeoutMs) {
  let resolveIdle;
  let rejectWithError;
  const idlePromise = new Promise((resolve, reject) => {
    resolveIdle = resolve;
    rejectWithError = reject;
  });

  let turnContent = '';
  let turnOutputTokens = 0;
  let lastRequestId = null;
  let hadAssistantMessage = false;
  let hadAssistantStreamDelta = false;
  let hadToolActivity = false;
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
      const didReachCopilot = hadAssistantMessage || hadAssistantStreamDelta || hadToolActivity || !!lastRequestId;
      const error = Object.assign(
        new Error(`sendAndWait timed out after ${timeoutMs}ms while ${phase} – CLI session may be dead`),
        {
          code: 'SEND_TIMEOUT',
          phase,
          timeoutMs,
          lastTimeoutResetReason,
          didReachCopilot,
          hadAssistantMessage,
          hadAssistantStreamDelta,
          hadToolActivity,
          requestId: lastRequestId,
        },
      );
      rejectSendTimeout?.(error);
    }, timeoutMs);
  };

  if (activeTurn) activeTurn.refreshSendTimeout = refreshSendTimeout;

  const unsubscribe = session.on((event) => {
    if (event.type === 'assistant.message') {
      refreshSendTimeout('assistant_message');
      hadAssistantMessage = true;
      turnContent = event.data.content ?? '';
      if (Number.isFinite(event.data?.outputTokens)) {
        turnOutputTokens += event.data.outputTokens;
      }
      if (typeof event.data?.requestId === 'string' && event.data.requestId.trim()) {
        lastRequestId = event.data.requestId.trim();
      }
      const toolRequests = Array.isArray(event.data.toolRequests) ? event.data.toolRequests : [];
      if (toolRequests.length) {
        for (const request of toolRequests) {
          toolNamesById.set(request.toolCallId, request.name);
          const toolEntry = ensureTurnToolEntry(entry.activeTurn, request.toolCallId, request.name);
          if (toolEntry && request.arguments !== undefined) toolEntry.arguments = request.arguments;
        }
        logProxyEvent('tool_requests', {
          sessionKey: entry.sessionKey,
          sessionId: session.sessionId,
          turnId: entry.activeTurn?.id ?? null,
          toolRequests: toolRequests.map((r) => ({
            toolCallId: r.toolCallId,
            name: r.name,
            argumentsPreview: previewForLog(r.arguments, 800),
          })),
        });
      }
      if (entry.activeTurn) {
        queueTurnEvent(entry.activeTurn, { type: 'partial_message', content: turnContent });
      }
    } else if (event.type === 'assistant.message_delta') {
      const deltaContent = event.data?.deltaContent ?? '';
      if (deltaContent) {
        hadAssistantStreamDelta = true;
        turnContent += deltaContent;
      }
      if (deltaContent && entry.activeTurn) {
        queueTurnEvent(entry.activeTurn, { type: 'stream_delta', deltaContent });
      }
    } else if (event.type === 'tool.execution_start') {
      refreshSendTimeout('tool_execution_start');
      hadToolActivity = true;
      if (activeTurn) queueTurnEvent(activeTurn, { type: 'tool_activity', reason: 'tool_start', toolName: event.data.toolName });
      toolNamesById.set(event.data.toolCallId, event.data.toolName);
      const toolEntry = ensureTurnToolEntry(entry.activeTurn, event.data.toolCallId, event.data.toolName);
      if (toolEntry && event.data.arguments !== undefined) toolEntry.arguments = event.data.arguments;
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
      hadToolActivity = true;
      if (activeTurn) queueTurnEvent(activeTurn, { type: 'tool_activity', reason: 'tool_progress' });
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
      hadToolActivity = true;
      const toolEntry = ensureTurnToolEntry(
        entry.activeTurn,
        event.data.toolCallId,
        toolNamesById.get(event.data.toolCallId) ?? 'tool',
      );
      if (toolEntry) toolEntry.partialOutput = formatToolOutputText(event.data.partialOutput) ?? undefined;
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
      hadToolActivity = true;
      const toolEntry = ensureTurnToolEntry(
        entry.activeTurn,
        event.data.toolCallId,
        toolNamesById.get(event.data.toolCallId) ?? event.data.toolCallId,
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
    ? new Promise((_, reject) => { rejectSendTimeout = reject; })
    : null;

  refreshSendTimeout('send_started');

  try {
    await session.send(options);
    if (sendTimeoutPromise) {
      await Promise.race([idlePromise, sendTimeoutPromise]);
    } else {
      await idlePromise;
    }
    return {
      data: {
        content: turnContent,
        outputTokens: turnOutputTokens,
        requestId: lastRequestId,
        hadAssistantMessage,
        hadAssistantStreamDelta,
        hadToolActivity,
        didReachCopilot: hadAssistantMessage || hadAssistantStreamDelta || hadToolActivity || !!lastRequestId,
      },
    };
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

export async function readShutdownMetrics(sessionId) {
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

  return { eventsPath: candidates[0], shutdown: null, error: 'no shutdown event found in standard locations' };
}
