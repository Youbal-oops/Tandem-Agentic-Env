// Where the server lives, what it trusts, and how it answers browsers.
// Security model: bound to 127.0.0.1 only; Host and Origin are checked on every request;
// the WebSocket needs a per-launch random token.

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(process.env.TANDEM_APP_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
export const ROOT = path.resolve(process.env.TANDEM_DATA_ROOT || APP_ROOT);
export const DIST = path.join(APP_ROOT, 'dist');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.TANDEM_PORT || 4317);
export const UI_DEV_PORT = 5173;
export const TOKEN = crypto.randomBytes(24).toString('hex');
export const MAX_TEXT = 40000;
export const AGENT_IDS = ['claude', 'codex'];

const hosts = new Set([PORT, UI_DEV_PORT].flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
export const origins = new Set([...hosts].map((h) => `http://${h}`));

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const hostOk = (req) => hosts.has(String(req.headers.host || '').toLowerCase());
export const originOk = (req) => req.headers.origin === undefined || origins.has(req.headers.origin);
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
