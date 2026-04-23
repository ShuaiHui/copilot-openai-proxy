// db.mjs — SQLite persistent request log (Node 25+ node:sqlite)
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB_DIR = path.join(os.homedir(), '.openclaw', 'logs');
const DB_PATH = path.join(DB_DIR, 'copilot-proxy.db');

let db = null;

/**
 * Initialize SQLite database. Call once at startup.
 * Safe to call multiple times (idempotent).
 */
export function initDb() {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS requests (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        INTEGER NOT NULL,
        model     TEXT    NOT NULL,
        status    TEXT    NOT NULL,
        latency_ms      INTEGER,
        tokens_prompt   INTEGER DEFAULT 0,
        tokens_completion INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ts    ON requests(ts);
      CREATE INDEX IF NOT EXISTS idx_model ON requests(model);
      CREATE INDEX IF NOT EXISTS idx_status ON requests(status);
    `);
    console.error(`[db] SQLite log initialized: ${DB_PATH}`);
  } catch (err) {
    console.error('[db] Failed to init SQLite:', err.message);
    db = null;
  }
}

/**
 * Write one request record. Silently skips if DB not initialized.
 * @param {object} opts
 * @param {string} opts.model
 * @param {'completed'|'timeout'|'error'} opts.status
 * @param {number|null} [opts.latencyMs]
 * @param {number} [opts.tokensPrompt]
 * Token columns are kept in the schema for historical compatibility but are no longer written.
 */
export function logRequest({ model, status, latencyMs = null }) {
  if (!db) return;
  try {
    db.prepare(
      'INSERT INTO requests (ts, model, status, latency_ms, tokens_prompt, tokens_completion) VALUES (?, ?, ?, ?, 0, 0)'
    ).run(Date.now(), model, status, latencyMs ?? null);
  } catch (err) {
    console.error('[db] Failed to log request:', err.message);
  }
}

/**
 * Query recent request log.
 * @param {object} [opts]
 * @param {number} [opts.limit=100]     max rows returned (capped at 500)
 * @param {string} [opts.model]         filter by model
 * @param {string} [opts.status]        filter by status
 * @param {number} [opts.since]         filter ts >= since (epoch ms)
 * @returns {object[]}
 */
export function queryLogs({ limit = 100, model = null, status = null, since = null } = {}) {
  if (!db) return [];
  try {
    const cap = Math.min(Number(limit) || 100, 500);
    let sql = 'SELECT id, ts, model, status, latency_ms, tokens_prompt, tokens_completion FROM requests WHERE 1=1';
    const params = [];
    if (model)  { sql += ' AND model = ?';  params.push(model); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (since)  { sql += ' AND ts >= ?';    params.push(Number(since)); }
    sql += ' ORDER BY ts DESC LIMIT ?';
    params.push(cap);
    return db.prepare(sql).all(...params);
  } catch (err) {
    console.error('[db] Failed to query logs:', err.message);
    return [];
  }
}

/** Returns summary stats grouped by model (last N days). */
export function queryLogStats({ days = 7 } = {}) {
  if (!db) return [];
  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    return db.prepare(`
      SELECT
        model,
        COUNT(*) AS total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status='timeout'   THEN 1 ELSE 0 END) AS timeouts,
        SUM(CASE WHEN status='error'     THEN 1 ELSE 0 END) AS errors,
        ROUND(AVG(CASE WHEN status='completed' THEN latency_ms END)) AS avg_latency_ms,
        SUM(tokens_prompt)     AS total_tokens_prompt,
        SUM(tokens_completion) AS total_tokens_completion
      FROM requests
      WHERE ts >= ?
      GROUP BY model
      ORDER BY total DESC
    `).all(since);
  } catch (err) {
    console.error('[db] Failed to query stats:', err.message);
    return [];
  }
}

export function getDbPath() { return DB_PATH; }
export function isDbReady() { return db !== null; }
