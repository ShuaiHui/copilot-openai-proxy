// metrics.mjs — request metrics accumulator; exposed via GET /metrics
import { nowMs } from './config.mjs';
import { logRequest } from './db.mjs';

const startedAt = nowMs();

let requestsTotal = 0;
let requestsCompleted = 0;
let requestsTimeout = 0;
let requestsError = 0;

/** @type {Map<string, {requests:number,completed:number,timeouts:number,errors:number,latencyTotalMs:number}>} */
const perModel = new Map();

function ensureModel(model) {
  if (!perModel.has(model)) {
    perModel.set(model, {
      requests: 0,
      completed: 0,
      timeouts: 0,
      errors: 0,
      latencyTotalMs: 0,
    });
  }
  return perModel.get(model);
}

/** Call once per incoming /v1/chat/completions request, after model is resolved. */
export function recordRequest(model) {
  requestsTotal += 1;
  ensureModel(model).requests += 1;
}

/** Call when a completed (status=completed) response is sent. */
export function recordCompleted(model, latencyMs) {
  requestsCompleted += 1;
  const s = ensureModel(model);
  s.completed += 1;
  s.latencyTotalMs += latencyMs;
  logRequest({ model, status: 'completed', latencyMs });
}

/** Call when a request ends due to TURN_EVENT_TIMEOUT or SEND_TIMEOUT. */
export function recordTimeout(model) {
  requestsTimeout += 1;
  ensureModel(model).timeouts += 1;
  logRequest({ model, status: 'timeout' });
}

/** Call when a request ends with an unexpected server error. */
export function recordError(model) {
  requestsError += 1;
  ensureModel(model).errors += 1;
  logRequest({ model, status: 'error' });
}

/** Returns a snapshot suitable for JSON serialisation. */
export function getMetricsSnapshot(sessionMap) {
  const models = {};
  for (const [model, s] of perModel) {
    models[model] = {
      requests: s.requests,
      completed: s.completed,
      timeouts: s.timeouts,
      errors: s.errors,
      avgLatencyMs: s.completed > 0 ? Math.round(s.latencyTotalMs / s.completed) : null,
    };
  }
  return {
    uptimeMs: nowMs() - startedAt,
    sessions: { active: sessionMap.size },
    requestsTotal,
    requestsCompleted,
    requestsTimeout,
    requestsError,
    models,
  };
}
