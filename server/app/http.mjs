// The HTTP side: the built UI, image uploads, the job API agents use to start child chats, and the session handshake.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CSP, DIST, MIME, ROOT, TOKEN, hostOk, originOk, safeEqual } from './config.mjs';
import { MODES } from '../agents.mjs';
import { MAX_IMAGE_BYTES } from '../images.mjs';

const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

/** Read a request body up to `limit` bytes. Resolves null (after answering 413) when it is too large. */
function readBody(req, res, limit) {
  return new Promise((resolve) => {
    let body = '', tooLarge = false;
    req.on('data', (chunk) => { body += chunk; if (Buffer.byteLength(body) > limit) { tooLarge = true; res.writeHead(413).end(); req.destroy(); resolve(null); } });
    req.on('end', () => { if (!tooLarge) resolve(body); });
  });
}

export function createHttpServer({ agents, images, delegationKeys, gitStatus, getClone, modelChoices }) {
  function uploadImage(req, res) {
    if (!safeEqual(String(req.headers.authorization || '').replace(/^Bearer /, ''), TOKEN)) { res.writeHead(403).end('Forbidden'); return; }
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= MAX_IMAGE_BYTES) chunks.push(chunk); });
    req.on('end', () => {
      try {
        if (size > MAX_IMAGE_BYTES) { json(res, 413, { error: 'Images must be at most 10 MB each.' }); return; }
        json(res, 201, images.save(Buffer.concat(chunks)));
      } catch (e) { json(res, 400, { error: e.message }); }
    });
  }

  function readImage(req, res, url) {
    try {
      const image = images.read(url.pathname.slice('/api/images/'.length));
      res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.data.length });
      res.end(req.method === 'HEAD' ? undefined : image.data);
    } catch { res.writeHead(404).end('Image not found'); }
  }

  /** `tandem-job.mjs` calls this: start a child chat, ask its status, read its result, message or cancel it. */
  async function jobs(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const parent = agents.configs().find((c) => {
      const auth = delegationKeys.get(c.id);
      return auth?.conversationId === c.conversationId && safeEqual(auth.key, bearer);
    });
    if (!parent) { res.writeHead(403).end('Forbidden'); return; }
    const body = await readBody(req, res, 128 * 1024);
    if (body === null) return;
    try {
      const m = JSON.parse(body);
      let result;
      if (m.action === 'start') result = agents.childAction({ t: 'child-create', agent: parent.id, provider: m.provider, text: m.text, model: m.model, effort: m.effort, viaAgent: true });
      else {
        const child = agents.children().find((c) => c.id === m.id && c.parentId === parent.id);
        if (!child) throw new Error('Unknown child job for this conversation.');
        if (m.action === 'message' || m.action === 'cancel') result = agents.childAction({ id: child.id, action: m.action === 'message' ? 'send' : 'stop', text: m.text });
        else if (m.action === 'status' || m.action === 'result') result = child;
        else throw new Error('Unknown job action.');
      }
      json(res, 200, { id: result.id, title: result.title, busy: result.meta.busy, status: result.meta.status, ...(m.action === 'result' ? { events: result.events } : {}) });
    } catch (e) { json(res, 400, { error: e.message }); }
  }

  function session(res) {
    json(res, 200, {
      token: TOKEN,
      git: gitStatus.current,
      modes: MODES,
      models: modelChoices(),
      learningMode: agents.localState().learningMode,
      agents: agents.configs(),
      clone: getClone(),
      cloneParent: path.dirname(ROOT),
      local: agents.localState(),
    });
  }

  function serveUi(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.join(DIST, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(DIST + path.sep) && file !== DIST) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (!fs.existsSync(DIST)) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Tandem API is running. Build the UI with "npm run build" or open the dev UI at http://localhost:5173');
        return;
      }
      file = path.join(DIST, 'index.html');
    }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}) });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  }

  return http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (!hostOk(req) || !originOk(req) || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end('Forbidden'); return; }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/images' && req.method === 'POST') return uploadImage(req, res);
    if (url.pathname.startsWith('/api/images/') && ['GET', 'HEAD'].includes(req.method)) return readImage(req, res, url);
    if (url.pathname === '/api/jobs') return jobs(req, res);
    if (url.pathname === '/api/session') return session(res);
    serveUi(req, res, url);
  });
}
