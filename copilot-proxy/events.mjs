// events.mjs — logging helpers, deferred promises, turn event queue
import { logger, inferLevel } from './logger.mjs';

/**
 * Log a proxy event as structured JSON.
 * @param {string} kind   - event kind, e.g. 'request', 'turn_error'
 * @param {object} payload
 * @param {string} [level] - 'debug'|'info'|'warn'|'error' (auto-inferred from kind when omitted)
 */
export function logProxyEvent(kind, payload, level) {
  const resolvedLevel = level ?? inferLevel(kind);
  logger[resolvedLevel](`proxy:${kind}`, payload);
}

export function previewForLog(value, maxLength = 500) {
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

export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function queueTurnEvent(turn, event) {
  const waiter = turn.waiters.shift();
  if (waiter) {
    waiter.resolve(event);
    return;
  }
  turn.events.push(event);
}

export function rejectTurnWaiters(turn, error) {
  while (turn.waiters.length) {
    const waiter = turn.waiters.shift();
    waiter.reject(error);
  }
}

export function waitForTurnEvent(turn, timeoutMs = null) {
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
      reject(Object.assign(
        new Error(`Timeout after ${timeoutMs}ms waiting for turn event`),
        { code: 'TURN_EVENT_TIMEOUT' },
      ));
    }, timeoutMs);
  });

  return Promise.race([waiter.promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}
