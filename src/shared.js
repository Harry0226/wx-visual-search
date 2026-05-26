import crypto from 'node:crypto';

export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactText(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

export function splitQuery(value) {
  return String(value ?? '')
    .trim()
    .split(/[\s,，、;；/\\|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function splitKeywords(value) {
  const source = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  return [...new Set(source
    .split(/[\r\n,，、;；/\\|]+/)
    .map((part) => part.trim())
    .filter(Boolean))];
}

export function makeMessageKey(message) {
  const seed = [
    message.chat_id,
    message.local_id ?? '',
    message.ts ?? '',
    message.sender_username ?? '',
    message.content ?? ''
  ].join('|');
  return crypto.createHash('sha1').update(seed).digest('hex');
}

export function formatDateTime(value) {
  const date = value ? new Date(value) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(value) {
  const date = value ? new Date(value) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function uniq(list) {
  return [...new Set(list)];
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
