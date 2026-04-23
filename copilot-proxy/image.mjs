// image.mjs — image attachment handling (base64, data-url, file, remote-url)
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROXY_TMP_DIR, REMOTE_IMAGE_CACHE_MAX } from './config.mjs';
import { latestUserMessageObject } from './messages.mjs';

export const remoteImageCache = new Map(); // url → localFilePath (LRU)

export function remoteImageCacheSet(url, filePath) {
  if (remoteImageCache.size >= REMOTE_IMAGE_CACHE_MAX) {
    const oldestKey = remoteImageCache.keys().next().value;
    remoteImageCache.delete(oldestKey);
  }
  remoteImageCache.set(url, filePath);
}

export function extensionForMimeType(mimeType) {
  const normalized = String(mimeType ?? '').trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/svg+xml') return '.svg';
  return '';
}

export function extensionFromUrlString(urlString) {
  try {
    const parsed = new URL(urlString);
    const ext = path.extname(parsed.pathname || '').trim();
    return ext || '';
  } catch {
    return path.extname(String(urlString ?? '').trim()) || '';
  }
}

export function imageAttachmentFromPart(part, index, messageIndex) {
  if (!part || typeof part !== 'object') return null;

  const partType = typeof part.type === 'string' ? part.type : '';
  const imageUrlField = part.image_url ?? part.imageUrl ?? null;
  const imageUrl = typeof imageUrlField === 'string'
    ? imageUrlField
    : (typeof imageUrlField?.url === 'string' ? imageUrlField.url : null);
  const directUrl = typeof part.url === 'string' ? part.url : null;
  const mimeType = typeof part.mimeType === 'string'
    ? part.mimeType
    : (typeof part.media_type === 'string' ? part.media_type : null);
  const base64Data = typeof part.data === 'string'
    ? part.data
    : (typeof part.base64 === 'string' ? part.base64 : null);

  if (partType === 'image' && base64Data) {
    return {
      kind: 'base64',
      mimeType: mimeType || 'image/png',
      data: base64Data,
      displayName: `image-${messageIndex + 1}-${index + 1}${extensionForMimeType(mimeType || 'image/png')}`,
    };
  }

  const sourceUrl = imageUrl || directUrl;
  if (!sourceUrl) return null;

  if (sourceUrl.startsWith('data:')) {
    return { kind: 'data-url', url: sourceUrl, displayName: `image-${messageIndex + 1}-${index + 1}` };
  }

  if (sourceUrl.startsWith('file://')) {
    return {
      kind: 'file-url',
      url: sourceUrl,
      displayName: path.basename(fileURLToPath(sourceUrl)),
    };
  }

  if (sourceUrl.startsWith('/')) {
    return { kind: 'path', path: sourceUrl, displayName: path.basename(sourceUrl) };
  }

  if (/^https?:\/\//i.test(sourceUrl)) {
    return {
      kind: 'remote-url',
      url: sourceUrl,
      displayName: `image-${messageIndex + 1}-${index + 1}${extensionFromUrlString(sourceUrl)}`,
    };
  }

  return null;
}

export function collectImageSourcesFromMessage(message, messageIndex = 0) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .map((part, index) => imageAttachmentFromPart(part, index, messageIndex))
    .filter(Boolean);
}

export async function materializeImageAttachment(source, attachmentIndex = 0) {
  if (!source) return null;

  if (source.kind === 'path') {
    return { type: 'file', path: source.path, displayName: source.displayName || path.basename(source.path) };
  }

  if (source.kind === 'file-url') {
    const filePath = fileURLToPath(source.url);
    return { type: 'file', path: filePath, displayName: source.displayName || path.basename(filePath) };
  }

  await fs.mkdir(PROXY_TMP_DIR, { recursive: true });

  if (source.kind === 'base64') {
    const extension = extensionForMimeType(source.mimeType) || '.bin';
    const filePath = path.join(PROXY_TMP_DIR, `${crypto.randomUUID()}-${attachmentIndex}${extension}`);
    await fs.writeFile(filePath, Buffer.from(source.data, 'base64'));
    return { type: 'file', path: filePath, displayName: source.displayName || path.basename(filePath) };
  }

  if (source.kind === 'data-url') {
    const match = source.url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
    if (!match) throw new Error('Unsupported data URL image payload');
    const mimeType = match[1] || 'application/octet-stream';
    const encoded = match[3] || '';
    const isBase64 = Boolean(match[2]);
    const extension = extensionForMimeType(mimeType) || '.bin';
    const filePath = path.join(PROXY_TMP_DIR, `${crypto.randomUUID()}-${attachmentIndex}${extension}`);
    const buffer = isBase64
      ? Buffer.from(encoded, 'base64')
      : Buffer.from(decodeURIComponent(encoded), 'utf8');
    await fs.writeFile(filePath, buffer);
    return {
      type: 'file',
      path: filePath,
      displayName: source.displayName ? `${source.displayName}${extension}` : path.basename(filePath),
    };
  }

  if (source.kind === 'remote-url') {
    if (remoteImageCache.has(source.url)) {
      const cachedPath = remoteImageCache.get(source.url);
      try {
        await fs.access(cachedPath);
        return { type: 'file', path: cachedPath, displayName: source.displayName || path.basename(cachedPath) };
      } catch {
        remoteImageCache.delete(source.url);
      }
    }
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image attachment: ${response.status} ${response.statusText}`);
    }
    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const extension = extensionFromUrlString(source.url) || extensionForMimeType(mimeType) || '.bin';
    const filePath = path.join(PROXY_TMP_DIR, `${crypto.randomUUID()}-${attachmentIndex}${extension}`);
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
    remoteImageCacheSet(source.url, filePath);
    return { type: 'file', path: filePath, displayName: source.displayName || path.basename(filePath) };
  }

  return null;
}

export async function collectCopilotImageAttachments(messages, latestOnly = false) {
  const userMessages = latestOnly
    ? [latestUserMessageObject(messages)].filter(Boolean)
    : messages.filter((message) => message?.role === 'user');

  const imageSources = userMessages.flatMap((message, index) => collectImageSourcesFromMessage(message, index));
  if (!imageSources.length) return [];

  const attachments = [];
  for (const [index, source] of imageSources.entries()) {
    const attachment = await materializeImageAttachment(source, index);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}
