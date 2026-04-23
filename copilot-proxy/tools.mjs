// tools.mjs — OpenAI tool normalization, Copilot tool bridge, tool call state management
import process from 'node:process';
import { OPENAI_FUNCTION_TOOL_TYPE, COPILOT_ALLOWED_BUILT_IN_TOOLS } from './config.mjs';
import { createDeferred, queueTurnEvent } from './events.mjs';
import { nowMs } from './config.mjs';

// ── OpenAI tool normalization ────────────────────────────────────────────────
export function normalizeOpenAITools(tools) {
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
          parameters: fn.parameters && typeof fn.parameters === 'object'
            ? fn.parameters
            : { type: 'object', properties: {} },
        },
      };
    })
    .filter(Boolean);
}

export function shouldExposeOpenClawMessageTool() {
  const raw = String(process.env.COPILOT_EXPOSE_OPENCLAW_MESSAGE_TOOL ?? '').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export function filterClientToolsForCopilot(clientTools) {
  if (shouldExposeOpenClawMessageTool()) return clientTools;
  return clientTools.filter((tool) => tool.function.name !== 'message');
}

export function serializeClientTools(tools) {
  return JSON.stringify(
    tools.map((tool) => ({
      type: OPENAI_FUNCTION_TOOL_TYPE,
      function: {
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      },
    })),
  );
}

export function normalizeCopilotBuiltInToolNames(result) {
  if (!Array.isArray(result?.tools)) return [];
  return result.tools
    .map((tool) => (typeof tool?.name === 'string' ? tool.name.trim() : ''))
    .filter(Boolean);
}

export function buildExcludedCopilotTools(builtInToolNames) {
  return [...new Set(builtInToolNames.filter((name) => !COPILOT_ALLOWED_BUILT_IN_TOOLS.has(name)))];
}

export function normalizeToolCallArguments(rawArgs) {
  if (rawArgs == null) return {};
  if (typeof rawArgs === 'string') {
    try { return JSON.parse(rawArgs); } catch { return {}; }
  }
  if (typeof rawArgs === 'object') return rawArgs;
  return {};
}

// ── Tool result message helpers ───────────────────────────────────────────────
export function toolMessageContentText(content) {
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
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  if (content && typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return '';
}

export function normalizeToolResultMessage(message) {
  const content = toolMessageContentText(message?.content);
  return content.trim() ? content : 'OK';
}

export function isSyntheticToolRepairMessage(message) {
  const text = normalizeToolResultMessage(message).toLowerCase();
  return text.includes('missing tool result in session history')
    || text.includes('transcript repair')
    || text.includes('gateway restarted')
    || text.includes('tool result unavailable after restart');
}

export function shouldAutoRecoverMissingToolResults() {
  const raw = String(process.env.COPILOT_AUTO_RECOVER_MISSING_TOOL_RESULTS ?? '1').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

export function buildSyntheticMissingToolResult(pending, message = null) {
  const details = message ? normalizeToolResultMessage(message) : null;
  const payload = {
    ok: false,
    interrupted: true,
    tool: pending?.name ?? 'tool',
    toolCallId: pending?.id ?? null,
    error: 'OpenClaw tool result was unavailable before it could be delivered back to Copilot. '
      + 'This usually means the OpenClaw gateway restarted, repaired session history, or otherwise lost the in-flight tool result.',
    details: details || null,
  };
  return JSON.stringify(payload, null, 2);
}

export function shouldRestartSessionAfterSyntheticToolRepair(toolMessages, missingToolCalls) {
  if (!shouldAutoRecoverMissingToolResults()) return false;
  if (!Array.isArray(missingToolCalls) || missingToolCalls.length === 0) return false;
  if (!Array.isArray(toolMessages) || toolMessages.length === 0) return false;
  return toolMessages.some((message) => isSyntheticToolRepairMessage(message));
}

export function shouldSilentlyIgnoreStaleToolRepairRequest(messages, toolMessages) {
  if (!Array.isArray(toolMessages) || toolMessages.length === 0) return false;

  // latestToolMessages() already returns the trailing contiguous tool-result block.
  // If that whole tail is synthetic repair noise, treat the request as stale replay
  // and ignore it instead of re-running the old user prompt in a fresh session.
  return toolMessages.every((message) => isSyntheticToolRepairMessage(message));
}

export function resolveToolCallIdFromMessage(message) {
  const direct = message?.tool_call_id ?? message?.toolCallId ?? message?.tool_use_id ?? message?.toolUseId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return null;
}

export function normalizeToolCallIdForMatch(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function describeToolMessageForLog(message) {
  return {
    role: message?.role ?? null,
    type: message?.type ?? null,
    name: message?.name ?? message?.toolName ?? null,
    tool_call_id: message?.tool_call_id ?? null,
    toolCallId: message?.toolCallId ?? null,
    tool_use_id: message?.tool_use_id ?? null,
    toolUseId: message?.toolUseId ?? null,
    contentPreview: (() => {
      const v = message?.content ?? null;
      if (v == null) return null;
      let t;
      try { t = typeof v === 'string' ? v : JSON.stringify(v); } catch { t = String(v); }
      return t.length > 500 ? `${t.slice(0, 500)}...` : t;
    })(),
  };
}

// ── Pending tool call state ───────────────────────────────────────────────────
export function toolCallsSnapshot(entry) {
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

export function ensurePendingToolCallState(entry) {
  if (!(entry.pendingToolCalls instanceof Map)) {
    entry.pendingToolCalls = new Map();
  }
  return entry.pendingToolCalls;
}

export function schedulePendingToolCallEvent(entry) {
  const turn = entry.activeTurn;
  if (!turn) return;
  if (turn.pendingToolCallEventScheduled) return;

  turn.pendingToolCallEventScheduled = true;
  setTimeout(() => {
    turn.pendingToolCallEventScheduled = false;
    if (!entry.activeTurn || entry.activeTurn.id !== turn.id) return;
    if (!entry.pendingToolCalls?.size) return;
    queueTurnEvent(turn, { type: 'tool_calls_required' });
  }, 0);
}

export function buildCopilotToolsFromOpenAITools(clientTools, entry) {
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

// ── Turn tool state ───────────────────────────────────────────────────────────
export function ensureTurnToolState(turn) {
  if (!turn) return null;
  if (!(turn.toolCallsById instanceof Map)) turn.toolCallsById = new Map();
  if (!Array.isArray(turn.toolCallOrder)) turn.toolCallOrder = [];
  return turn;
}

export function ensureTurnToolEntry(turn, toolCallId, name = 'tool') {
  const state = ensureTurnToolState(turn);
  if (!state || !toolCallId) return null;

  let entry = state.toolCallsById.get(toolCallId);
  if (!entry) {
    entry = { toolCallId, name, arguments: undefined, output: undefined, partialOutput: undefined };
    state.toolCallsById.set(toolCallId, entry);
    state.toolCallOrder.push(toolCallId);
  } else if (name && !entry.name) {
    entry.name = name;
  }
  return entry;
}

export function formatToolOutputText(value) {
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
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function buildAssistantMessageContent(content, turn) {
  const text = String(content ?? '').trim();
  const state = ensureTurnToolState(turn);
  const blocks = [];

  if (text) blocks.push({ type: 'text', text });

  if (state?.toolCallOrder?.length) {
    for (const toolCallId of state.toolCallOrder) {
      const entry = state.toolCallsById.get(toolCallId);
      if (!entry) continue;
      blocks.push({ type: 'toolcall', id: toolCallId, name: entry.name || 'tool', arguments: entry.arguments ?? {} });
      const output = entry.output ?? entry.partialOutput;
      if (output) blocks.push({ type: 'toolresult', name: entry.name || 'tool', text: output });
    }
  }

  if (blocks.length === 0) return text;
  if (blocks.length === 1 && blocks[0].type === 'text') return text;
  return blocks;
}

export function textPreviewFromAssistantContent(content) {
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
