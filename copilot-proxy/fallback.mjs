// fallback.mjs — try external OpenAI-compatible providers when Copilot fails
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hot-reload fallbacks.json every 30 s (non-blocking: background refresh, serve stale cache)
let cachedProviders = [];
let cacheLoadedAt = 0;
let refreshInFlight = false;
const CACHE_TTL_MS = 30_000;

function resolveApiKey(raw) {
  if (typeof raw !== 'string') return raw ?? '';
  if (raw.startsWith('env:')) return process.env[raw.slice(4)] ?? '';
  return raw;
}

function refreshFallbackCache() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const configPath = path.join(__dirname, 'fallbacks.json');
  fs.readFile(configPath, 'utf8')
    .then((raw) => {
      cachedProviders = JSON.parse(raw);
      cacheLoadedAt = Date.now();
    })
    .catch(() => {
      cachedProviders = [];
      cacheLoadedAt = Date.now();
    })
    .finally(() => { refreshInFlight = false; });
}

// Eagerly load on startup
refreshFallbackCache();

export function loadFallbackProviders() {
  if ((Date.now() - cacheLoadedAt) >= CACHE_TTL_MS) refreshFallbackCache(); // background, no await
  return cachedProviders;
}

/**
 * Try fallback providers in order.
 * Returns { response: object, providerName: string } on success, throws if all fail.
 * Always requests non-streaming from the fallback provider.
 */
export async function tryFallbackProviders(originalBody, timeoutMs = 30_000) {
  const providers = loadFallbackProviders();
  if (!providers.length) throw new Error('No fallback providers configured');

  const errors = [];
  for (const provider of providers) {
    const label = provider.name ?? provider.baseUrl;
    try {
      const response = await callProvider(provider, originalBody, timeoutMs);
      return { response, providerName: label };
    } catch (err) {
      console.warn(`[fallback] ${label} failed: ${err.message}`);
      errors.push(`${label}: ${err.message}`);
    }
  }
  throw new Error(`All fallback providers failed — ${errors.join('; ')}`);
}

function callProvider(provider, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL('/v1/chat/completions', provider.baseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    // Always non-streaming: avoids half-sent SSE edge cases
    const requestBody = JSON.stringify({
      ...body,
      model: provider.model ?? body.model,
      stream: false,
    });

    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${resolveApiKey(provider.apiKey)}`,
        'content-length': Buffer.byteLength(requestBody),
      },
    }, (res2) => {
      let data = '';
      res2.on('data', (chunk) => { data += chunk; });
      res2.on('end', () => {
        if (res2.statusCode >= 200 && res2.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON (HTTP ${res2.statusCode}): ${data.slice(0, 200)}`));
          }
        } else {
          reject(new Error(`HTTP ${res2.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}
