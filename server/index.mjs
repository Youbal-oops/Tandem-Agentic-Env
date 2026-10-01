// Tandem local server.
//
// Runs Claude Code and Codex CLI as chat sessions and streams them to the browser UI.
// Security model: bound to 127.0.0.1 only; Host and Origin are checked on every request;
// the WebSocket needs a per-launch random token; only the two known CLI binaries can be
// started (never a shell); the working directory is fixed at launch; API keys are never
// passed on to the agents, so they stay on your subscriptions.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync, execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { createAgents, MODES } from './agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HOST = '127.0.0.1';
const PORT = Number(process.env.TANDEM_PORT || 4317);
const UI_DEV_PORT = 5173;
const CWD = path.resolve(process.env.TANDEM_CWD || ROOT);
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_TEXT = 40000;

const hosts = new Set([PORT, UI_DEV_PORT].flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
const origins = new Set([...hosts].map((h) => `http://${h}`));
const AGENT_IDS = ['claude', 'codex'];

// ---------------------------------------------------------------- agent binaries

function npmRoots() {
  const roots = [];
  if (process.env.TANDEM_NPM_ROOT) roots.push(process.env.TANDEM_NPM_ROOT);
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    /* npm not on PATH; the other candidates may still work */
  }
  return roots;
}
function firstExisting(roots, rel) {
  for (const r of roots) {
    const p = path.join(r, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const roots = npmRoots();
const claudeExe = firstExisting(roots, ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe']);
const codexJs = firstExisting(roots, ['@openai', 'codex', 'bin', 'codex.js']);
const specs = {
  claude: claudeExe ? { file: claudeExe, args: [] } : null,
  codex: codexJs ? { file: process.execPath, args: [codexJs] } : null,
};

// ---------------------------------------------------------------- websocket plumbing

const clients = new Set();
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}
const agents = createAgents({ cwd: CWD, specs, broadcast });

// ---------------------------------------------------------------- git status for the "sun"

let git = { repo: path.basename(CWD), branch: '', ahead: 0, behind: 0, changed: 0, files: [], commits: [], pkg: null };
const run = (args) =>
  new Promise((resolve) =>
    execFile('git', ['-C', CWD, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out))),
  );

async function readGit() {
  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return;
  const [status, numstat, log, counts] = await Promise.all([
    run(['status', '--porcelain=v1', '-uall']),
    run(['diff', '--numstat', 'HEAD']),
    run(['log', '-6', '--pretty=format:%h%x09%an%x09%ar%x09%s']),
    run(['rev-list', '--left-right', '--count', '@{u}...HEAD']),
  ]);
  const stat = new Map();
  for (const l of (numstat || '').split('\n').filter(Boolean)) {
    const [add, del, ...p] = l.split('\t');
    stat.set(p.join('\t'), { add: Number(add) || 0, del: Number(del) || 0 });
  }
  const files = (status || '')
    .split('\n')
    .filter(Boolean)
    .slice(0, 60)
    .map((l) => {
      const code = l.slice(0, 2).trim() || 'M';
      const p = l.slice(3).replace(/^"|"$/g, '');
      return { s: code === '??' ? 'U' : code[0], p, ...(stat.get(p) || { add: 0, del: 0 }) };
    });
  const [behind, ahead] = (counts || '0\t0').trim().split(/\s+/).map(Number);
  let pkg = git.pkg;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CWD, 'package.json'), 'utf8'));
    pkg = { name: j.name, version: j.version, scripts: Object.keys(j.scripts || {}).slice(0, 8) };
  } catch {
    /* no package.json here */
  }
  const next = {
    repo: path.basename(CWD),
    branch: branch.trim(),
    ahead: ahead || 0,
    behind: behind || 0,
    changed: (status || '').split('\n').filter(Boolean).length,
    files,
    commits: (log || '').split('\n').filter(Boolean).map((l) => {
      const [h, a, t, ...s] = l.split('\t');
      return { h, a, t, s: s.join('\t') };
    }),
    pkg,
  };
  if (JSON.stringify(next) !== JSON.stringify(git)) {
    git = next;
    broadcast({ t: 'git', git });
  }
}
readGit();
setInterval(readGit, 3000).unref();

// ---------------------------------------------------------------- http

const MIME = {
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
const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const hostOk = (req) => hosts.has(String(req.headers.host || '').toLowerCase());
const originOk = (req) => req.headers.origin === undefined || origins.has(req.headers.origin);
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (!hostOk(req) || !originOk(req) || req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/session') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        token: TOKEN,
        git,
        modes: MODES,
        agents: AGENT_IDS.map((id) => ({ id, available: !!specs[id] })),
      }),
    );
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.join(DIST, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(DIST + path.sep) && file !== DIST) {
    res.writeHead(403).end();
    return;
  }
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
});

// ---------------------------------------------------------------- websocket

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const ok =
    url.pathname === '/ws' &&
    hostOk(req) &&
    req.headers.origin !== undefined &&
    origins.has(req.headers.origin) &&
    safeEqual(url.searchParams.get('token') || '', TOKEN);
  if (!ok) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.send(JSON.stringify({ t: 'snapshot', agents: agents.snapshot(), git }));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'sync') {
      ws.send(JSON.stringify({ t: 'snapshot', agents: agents.snapshot(), git }));
      return;
    }
    if (typeof m.agent !== 'string' || !AGENT_IDS.includes(m.agent)) return;
    switch (m.t) {
      case 'send':
        if (typeof m.text === 'string' && m.text.length <= MAX_TEXT) agents.send(m.agent, m.text);
        break;
      case 'stop':
        agents.stop(m.agent);
        break;
      case 'mode':
        if (typeof m.mode === 'string') agents.setMode(m.agent, m.mode);
        break;
      case 'newchat':
        agents.newChat(m.agent);
        break;
      case 'approve':
        agents.approve(m.agent, m.requestId, m.allow === true);
        break;
    }
  });
});

function shutdown() {
  agents.closeAll();
}
process.on('exit', shutdown);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    shutdown();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Tandem API  http://${HOST}:${PORT}   (agents work in: ${CWD})`);
  for (const id of AGENT_IDS) console.log(`  ${id.padEnd(7)} ${specs[id] ? 'found' : 'NOT FOUND (npm install -g the CLI)'}`);
  console.log('Dev UI      http://localhost:5173  (npm run dev)');
});
