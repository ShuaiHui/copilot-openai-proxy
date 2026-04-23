// messages.mjs — message text extraction, prompt building, request routing helpers
import process from 'node:process';
import { ASK_USER_PROMPT } from './config.mjs';

// ── Header / body helpers ─────────────────────────────────────────────────────
export function getHeaderValue(req, name) {
  const direct = req.headers?.[name];
  if (typeof direct === 'string') return direct.trim();
  if (Array.isArray(direct)) {
    const first = direct.find((value) => typeof value === 'string' && value.trim());
    return typeof first === 'string' ? first.trim() : null;
  }
  return null;
}

export function getSessionKey(req, body) {
  return getHeaderValue(req, 'x-copilot-session-key')
    || getHeaderValue(req, 'x-openclaw-session-key')
    || getHeaderValue(req, 'x-openclaw-session-id')  // fallback: OpenClaw native session UUID
    || body.session_key
    || body.sessionKey
    || null;
}

export function getMessageChannel(req, body) {
  return getHeaderValue(req, 'x-openclaw-message-channel')
    || body.message_channel
    || body.messageChannel
    || null;
}

export function getOpenClawRouteHint(req) {
  const parts = [
    getHeaderValue(req, 'x-openclaw-account-id'),
    getHeaderValue(req, 'x-openclaw-thread-id'),
    getHeaderValue(req, 'x-openclaw-message-to'),
  ].filter(Boolean);

  if (!parts.length) return null;
  return parts.join(':');
}

export function buildDefaultSessionKey(req, messageChannel) {
  const raw = String(process.env.COPILOT_SPLIT_DEFAULT_SESSION_BY_CHANNEL ?? '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) {
    const channel = String(messageChannel || 'default').trim() || 'default';
    return `default-session:${channel}`;
  }
  return 'default-session';
}

export function wantsNewSession(req, body) {
  const raw = req.headers['x-copilot-new-session'] ?? body.new_session ?? body.newSession ?? false;
  if (typeof raw === 'boolean') return raw;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).toLowerCase());
}

// ── Message content extraction ────────────────────────────────────────────────
export function messageTextContent(content) {
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

export function extractSystemMessageContent(messages) {
  const parts = messages
    .filter((msg) => msg.role === 'system')
    .map((msg) => messageTextContent(msg.content).trim())
    .filter(Boolean);
  return parts.length ? parts.join('\n\n') : null;
}

export function transcriptFromMessages(messages) {
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

export function latestUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return messageTextContent(messages[i].content);
    }
  }
  return '';
}

export function latestToolMessages(messages) {
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

export function latestUserMessageObject(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return messages[i];
    }
  }
  return null;
}

export function looksLikeOpenClawNewSessionPrompt(messages) {
  const pattern = /A new session was started via \/new or \/reset\./i;
  return pattern.test(latestUserMessage(messages));
}

// ── Prompt / system message building ─────────────────────────────────────────
export function shouldForceAskUser(_messages, _clientTools = []) {
  const raw = String(process.env.COPILOT_FORCE_ASK_USER ?? '1').toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(raw)) {
    return false;
  }
  return true;
}

export function appendAskUserPrompt(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return trimmed;
  return `${trimmed}\n\n${ASK_USER_PROMPT}`;
}

export function prependAskUserLabel(text) {
  return String(text ?? '').trim();
}

export function prependAskUserPromptAsSystem(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return trimmed;
  return `System:\n${ASK_USER_PROMPT}\n\n${trimmed}`;
}

export function appendSystemInstruction(text, instruction) {
  const base = String(text ?? '').trim();
  const extra = String(instruction ?? '').trim();
  if (!base) return extra;
  if (!extra) return base;
  return `${base}\n\n${extra}`;
}

export function buildChannelBehaviorInstruction(messageChannel) {
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

export function buildContinuationInjectedAnswer(text) {
  const continuationInstruction = process.env.COPILOT_CONTINUATION_INSTRUCTION?.trim();
  if (continuationInstruction) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return trimmed;
    return `${trimmed}\n\n${continuationInstruction}`;
  }
  return String(text ?? '').trim();
}

export function shouldRenderAskUserAsCompleted() {
  const raw = String(process.env.COPILOT_RENDER_ASK_USER_AS_COMPLETED ?? '1').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

export function normalizeUserInputReply(raw, pendingUserInput) {
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
