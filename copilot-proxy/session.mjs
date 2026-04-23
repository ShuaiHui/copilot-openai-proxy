// session.mjs — CopilotClient creation, session config, response building, model/session helpers
import crypto from 'node:crypto';
import { approveAll, CopilotClient } from '@github/copilot-sdk';
import { DEFAULTS, DEFAULT_COPILOT_BUILT_IN_TOOLS, nowMs } from './config.mjs';
import { createDeferred, queueTurnEvent } from './events.mjs';
import { buildCopilotToolsFromOpenAITools, buildExcludedCopilotTools, toolCallsSnapshot } from './tools.mjs';

// ── CopilotClient ─────────────────────────────────────────────────────────────
export async function buildClient(cwd) {
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

// ── Model helpers ─────────────────────────────────────────────────────────────
export function normalizeModelMap(models) {
  return new Map(models.map((m) => [m.id, m]));
}

export const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

export function normalizeReasoningEffort(value) {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (VALID_REASONING_EFFORTS.has(normalized)) return normalized;
  return undefined;
}

// ── Session config ────────────────────────────────────────────────────────────
export function makeSessionConfig(model, cwd, entry, clientTools = [], systemMessageContent = null) {
  const builtInToolNames = Array.isArray(entry.copilotBuiltInToolNames) && entry.copilotBuiltInToolNames.length
    ? entry.copilotBuiltInToolNames
    : DEFAULT_COPILOT_BUILT_IN_TOOLS;

  const config = {
    clientName: 'openclaw-copilot-openai-proxy',
    model,
    onPermissionRequest: approveAll,
    onUserInputRequest: async (request) => {
      if (!entry.activeTurn) throw new Error('ask_user requested with no active turn');
      if (entry.awaitingUserInput) throw new Error('ask_user requested while another ask_user is still pending');

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

// ── Response building ─────────────────────────────────────────────────────────
// Token counts are not meaningful for GitHub Copilot (billed per request, not per token).
// We log them as debug info only; the response usage field is always zeroed.
function debugLogTokenUsage(model, sessionKey, exactUsage, liveUsage) {
  const input = exactUsage?.inputTokens ?? liveUsage?.inputTokens ?? null;
  const output = exactUsage?.outputTokens ?? liveUsage?.outputTokens ?? null;
  if (input != null || output != null) {
    console.debug('[proxy:token_debug]', JSON.stringify({ model, sessionKey, input, output, source: exactUsage ? 'session.shutdown' : 'assistant.message' }));
  }
}

export function buildResponse({
  model,
  messageContent,
  toolCalls = null,
  metrics,
  liveUsage = null,
  sessionId,
  sessionKey,
  finishReason = 'stop',
  status = 'completed',
  pendingUserInput = null,
  entry = null,
}) {
  const modelMetrics = metrics?.shutdown?.modelMetrics?.[model];
  const exactUsage = modelMetrics?.usage ?? null;

  // Log token info for debugging only — not used for billing
  if (status === 'completed') debugLogTokenUsage(model, sessionKey, exactUsage, liveUsage);

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
    // Token counts are not meaningful for Copilot billing (per-request, not per-token).
    // Actual values are emitted as debug log via debugLogTokenUsage.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    copilot: {
      status,
      sessionId,
      sessionKey,
      totalPremiumRequests: metrics?.shutdown?.totalPremiumRequests ?? null,
      requestsCount: modelMetrics?.requests?.count ?? null,
      cost: modelMetrics?.requests?.cost ?? null,
      eventsPath: metrics?.eventsPath ?? null,
      usageSource: exactUsage ? 'session.shutdown' : (liveUsage ? 'assistant.message' : null),
      pendingUserInput,
      pendingToolCalls: entry?.pendingToolCalls?.size ? toolCallsSnapshot(entry) : null,
      turnsCompleted: entry?.turns ?? null,
      sendsStarted: entry?.sendsStarted ?? null,
      activeTurnId: entry?.activeTurn?.id ?? null,
      activeTurnState: entry?.activeTurn?.state ?? null,
    },
  };
}

export function buildIgnoredToolRepairResponse({ model, sessionKey, ignoredToolCalls = [] }) {
  const response = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    copilot: {
      status: 'ignored_stale_tool_results',
      sessionId: null,
      sessionKey,
      ignoredToolCalls,
    },
  };
  return response;
}
