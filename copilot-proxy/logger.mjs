// logger.mjs — structured JSON logger with level support
// Output: one JSON line per entry to stdout (info/debug) or stderr (warn/error)
// Control verbosity with LOG_LEVEL env var: debug | info | warn | error  (default: info)

import process from 'node:process';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel = LEVELS[String(process.env.LOG_LEVEL ?? 'info').toLowerCase()] ?? LEVELS.info;

function write(level, kind, payload) {
  if (LEVELS[level] < configuredLevel) return;
  const entry = { ts: new Date().toISOString(), level, kind, ...payload };
  const line = JSON.stringify(entry) + '\n';
  if (level === 'warn' || level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (kind, payload = {}) => write('debug', kind, payload),
  info:  (kind, payload = {}) => write('info',  kind, payload),
  warn:  (kind, payload = {}) => write('warn',  kind, payload),
  error: (kind, payload = {}) => write('error', kind, payload),
};

/**
 * Auto-infer level from kind name when not explicitly provided:
 *   contains 'error'  → 'error'
 *   contains 'fail' / 'retry' / 'recovery' / 'recreate' / 'stale' → 'warn'
 *   otherwise         → 'info'
 */
export function inferLevel(kind) {
  const k = String(kind).toLowerCase();
  if (k.includes('error')) return 'error';
  if (k.includes('fail') || k.includes('retry') || k.includes('recovery') || k.includes('recreate') || k.includes('stale')) return 'warn';
  return 'info';
}
