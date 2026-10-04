// Tandem local server.
//
// Runs Claude Code and Codex CLI as chat sessions and streams them to the browser UI.
// Security model: bound to 127.0.0.1 only; Host and Origin are checked on every request;
// the WebSocket needs a per-launch random token; only the two known CLI binaries can be
// started (never a shell). Repo changes require idle agents. CLI subprocesses do not
// inherit API keys; optional API chats read a named server environment variable.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync, execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { MODES } from './agents.mjs';
import { createWorkspace } from './workspace.mjs';
import { createRepoService } from './repos.mjs';
import { listRepoFiles, readRepoFile, readRepoDiff } from './inspect.mjs';
import { listFolders } from './folders.mjs';
import { createImageStore, MAX_IMAGE_BYTES } from './images.mjs';

const APP_ROOT = path.resolve(process.env.TANDEM_APP_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const ROOT = path.resolve(process.env.TANDEM_DATA_ROOT || APP_ROOT);
const DIST = path.join(APP_ROOT, 'dist');
const HOST = '127.0.0.1';
const PORT = Number(process.env.TANDEM_PORT || 4317);
const UI_DEV_PORT = 5173;
let CWD = path.resolve(process.env.TANDEM_CWD || ROOT);
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_TEXT = 40000;
const images = createImageStore(ROOT);

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
function nativeBinary(name) {
  if (process.platform === 'win32') {
    const candidate = path.join(os.homedir(), '.local', 'bin', `${name}.exe`);
    return fs.existsSync(candidate) ? candidate : null;
  }
  try { return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}
const nativeClaude = nativeBinary('claude');
const claudeExe = nativeClaude && fs.existsSync(nativeClaude) ? nativeClaude : firstExisting(roots, ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe']);
const codexJs = firstExisting(roots, ['@openai', 'codex', 'bin', 'codex.js']);
const nativeCodex = nativeBinary('codex');
const specs = {
  claude: claudeExe ? { file: claudeExe, args: [] } : null,
  codex: codexJs ? {
    file: process.execPath,
    args: [codexJs],
    // Electron can execute Node scripts when this child-only flag is set.
    environment: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  } : nativeCodex ? { file: nativeCodex, args: [] } : null,
};

function modelChoices() {
  let codex = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    codex = (cache.models || []).map((m) => m.slug).filter((m) => typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(m));
  } catch {}
  return { claude: ['opus', 'sonnet', 'haiku'], codex: [...new Set(codex)] };
}

// ---------------------------------------------------------------- websocket plumbing

const clients = new Set();
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}
const delegationKeys = new Map();
const jobScript = path.join(process.env.TANDEM_JOB_SCRIPT_ROOT || APP_ROOT, 'scripts', 'tandem-job.mjs');
const agents = createWorkspace({ root: ROOT, cwd: CWD, specs, broadcast, getAgentContext(config) {
  const key = crypto.randomBytes(24).toString('hex');
  delegationKeys.set(config.id, { key, conversationId: config.conversationId });
  return {
    environment: { TANDEM_JOB_URL: `http://${HOST}:${PORT}/api/jobs`, TANDEM_JOB_TOKEN: key, TANDEM_JOB_SCRIPT: jobScript },
    taskInstructions: `[Tandem child chats]\nWhen the user asks you to delegate work to Claude or Codex, use the local job command. Each job appears as a child chat attached to this conversation. Command: node "${jobScript}" start <claude|codex> "task description". Then use status <job-id>, result <job-id>, or message <job-id> "follow-up". Child tasks start in Edit mode; the user can change their permission mode in the child panel. Tasks share this repository. Read results before claiming completion. The user can also message the child directly. Do not print the TANDEM_JOB_TOKEN environment variable.`,
  };
} });
CWD = agents.cwd;
const repos = createRepoService();
let cloneState = { busy: false, text: '' };
const cloneStatus = (state) => { cloneState = state; broadcast({ t: 'clone', ...state }); };

// ---------------------------------------------------------------- git status for the "sun"

const emptyGit = () => ({ cwd: CWD, repo: path.basename(CWD), branch: '', ahead: 0, behind: 0, changed: 0, files: [], commits: [], pkg: null });
let git = emptyGit();
const run = (args, cwd = CWD) =>
  new Promise((resolve) =>
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out))),
  );

async function readGit() {
  const readingDir = CWD;
  const gitRun = (args) => run(args, readingDir);
  const branch = await gitRun(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return;
  const [status, numstat, log, counts] = await Promise.all([
    gitRun(['status', '--porcelain=v1', '-uall']),
    gitRun(['diff', '--numstat', 'HEAD']),
    gitRun(['log', '-6', '--pretty=format:%h%x09%an%x09%ar%x09%s']),
    gitRun(['rev-list', '--left-right', '--count', '@{u}...HEAD']),
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
  let pkg = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(readingDir, 'package.json'), 'utf8'));
    pkg = { name: j.name, version: j.version, scripts: Object.keys(j.scripts || {}).slice(0, 8) };
  } catch {
    /* no package.json here */
  }
  const next = {
    cwd: readingDir,
    repo: path.basename(readingDir),
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
  if (readingDir === CWD && JSON.stringify(next) !== JSON.stringify(git)) {
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

  if (url.pathname === '/api/images' && req.method === 'POST') {
    if (!safeEqual(String(req.headers.authorization || '').replace(/^Bearer /, ''), TOKEN)) { res.writeHead(403).end('Forbidden'); return; }
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= MAX_IMAGE_BYTES) chunks.push(chunk); });
    req.on('end', () => {
      try {
        if (size > MAX_IMAGE_BYTES) { res.writeHead(413).end(JSON.stringify({ error: 'Images must be at most 10 MB each.' })); return; }
        const image = images.save(Buffer.concat(chunks));
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(image));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (url.pathname.startsWith('/api/images/') && ['GET', 'HEAD'].includes(req.method)) {
    try {
      const image = images.read(url.pathname.slice('/api/images/'.length));
      res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.data.length });
      res.end(req.method === 'HEAD' ? undefined : image.data);
    } catch { res.writeHead(404).end('Image not found'); }
    return;
  }

  if (url.pathname === '/api/jobs') {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const parent = agents.configs().find((c) => {
      const auth = delegationKeys.get(c.id);
      return auth?.conversationId === c.conversationId && safeEqual(auth.key, bearer);
    });
    if (!parent) { res.writeHead(403).end('Forbidden'); return; }
    let body = '', tooLarge = false;
    req.on('data', (chunk) => { body += chunk; if (Buffer.byteLength(body) > 128 * 1024) { tooLarge = true; res.writeHead(413).end(); req.destroy(); } });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const m = JSON.parse(body);
        let result;
        if (m.action === 'start') result = agents.childAction({ t: 'child-create', agent: parent.id, provider: m.provider, text: m.text, model: m.model });
        else {
          const child = agents.children().find((c) => c.id === m.id && c.parentId === parent.id);
          if (!child) throw new Error('Unknown child job for this conversation.');
          if (m.action === 'message' || m.action === 'cancel') result = agents.childAction({ id: child.id, action: m.action === 'message' ? 'send' : 'stop', text: m.text });
          else if (m.action === 'status' || m.action === 'result') result = child;
          else throw new Error('Unknown job action.');
        }
        const output = { id: result.id, title: result.title, busy: result.meta.busy, status: result.meta.status,
          ...(m.action === 'result' ? { events: result.events } : {}) };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (url.pathname === '/api/session') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        token: TOKEN,
        git,
        modes: MODES,
        models: modelChoices(),
        agents: agents.configs(),
        clone: cloneState,
        cloneParent: path.dirname(ROOT),
        local: agents.localState(),
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
  ws.send(JSON.stringify({ t: 'snapshot', agents: agents.snapshot(), configs: agents.configs(), children: agents.children(), git, clone: cloneState }));

  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'sync') {
      ws.send(JSON.stringify({ t: 'snapshot', agents: agents.snapshot(), configs: agents.configs(), children: agents.children(), git, clone: cloneState }));
      return;
    }
    try {
      if (m.t === 'child-create' || m.t === 'child-action') {
        const child = agents.childAction(m);
        if (m.t === 'child-create') ws.send(JSON.stringify({ t: 'child-open', id: child.id }));
      } else if (m.t === 'localstate' || m.t === 'savenotes') {
        ws.send(JSON.stringify({ t: 'localstate', ...(m.t === 'savenotes' ? agents.saveNotes(m.cwd, m.text) : agents.localState()), saved: m.t === 'savenotes' }));
      } else if (m.t === 'saveprompt') {
        ws.send(JSON.stringify({ t: 'prompt', ...agents.savePrompt(m.text, m.on) }));
      } else if (m.t === 'savelearnerprofile') {
        ws.send(JSON.stringify({ t: 'learnerprofile', ...agents.saveLearnerProfile(m.profile) }));
      } else if (m.t === 'folders') {
        try { ws.send(JSON.stringify({ t: 'folders', request: m.request, ...await listFolders(m.path || os.homedir()) })); }
        catch (e) { ws.send(JSON.stringify({ t: 'folders', request: m.request, error: e.message })); }
      } else if (m.t === 'stopall') {
        agents.stopAll(); broadcast({ t: 'notice', text: 'Stopped all agent sessions. Conversations are kept.' });
      } else if (['files', 'file', 'diff'].includes(m.t)) {
        const cwd = agents.cwd;
        try {
          const data = m.t === 'files' ? listRepoFiles(cwd, m.path || '') : m.t === 'file' ? readRepoFile(cwd, m.path) : await readRepoDiff(cwd, m.mode);
          ws.send(JSON.stringify({ t: 'inspect', request: m.request, kind: m.t, cwd, ...data }));
        } catch (e) { ws.send(JSON.stringify({ t: 'inspect', request: m.request, cwd, error: e.message })); }
      } else if (m.t === 'githubrepos') {
        try { ws.send(JSON.stringify({ t: 'githubrepos', ...await repos.listAccountRepos(m.page ?? 1) })); }
        catch (e) { ws.send(JSON.stringify({ t: 'githubrepos', error: e.message })); }
      } else if (m.t === 'apimodels') {
        try {
          const endpoint = new URL(String(m.endpoint || ''));
          const keyEnv = String(m.keyEnv || '');
          if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new Error('Use HTTPS, or HTTP for a local model server.');
          if (keyEnv && !/^[A-Z][A-Z0-9_]{0,79}$/.test(keyEnv)) throw new Error('Enter an environment variable name, not an API key.');
          endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, '/models');
          if (!endpoint.pathname.endsWith('/models')) throw new Error('Use a Chat Completions endpoint ending in /chat/completions.');
          const response = await fetch(endpoint, { headers: keyEnv ? { Authorization: `Bearer ${process.env[keyEnv] || ''}` } : {} });
          if (!response.ok) throw new Error(`Model request returned HTTP ${response.status}. Check the endpoint and connection.`);
          const data = await response.json();
          const models = (data.data || data.models || []).map((row) => typeof row === 'string' ? row : row?.id).filter((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(id)).slice(0, 200);
          if (!models.length) throw new Error('This endpoint did not return any usable model IDs.');
          ws.send(JSON.stringify({ t: 'apimodels', models }));
        } catch (e) { ws.send(JSON.stringify({ t: 'apimodels', error: e.message })); }
      } else if (m.t === 'clone') {
        await agents.withRepoChange(async (switchTo) => {
          cloneStatus({ busy: true, text: 'Starting clone…' });
          let lastProgress = 0;
          try {
            const destination = await repos.clone(m, (text) => {
              if (Date.now() - lastProgress < 250) return;
              lastProgress = Date.now(); cloneStatus({ busy: true, text });
            });
            switchTo(destination); CWD = agents.cwd; git = emptyGit();
            cloneStatus({ busy: false, ok: true, text: `Cloned and opened ${path.basename(destination)}.`, destination });
            broadcast({ t: 'snapshot', agents: agents.snapshot(), configs: agents.configs(), children: agents.children(), git, clone: cloneState });
            await readGit();
          } catch (e) {
            cloneStatus({ busy: false, ok: false, text: e.message });
          }
        });
      } else if (m.t === 'repo') {
        agents.switchRepo(m.cwd); CWD = agents.cwd; git = emptyGit();
        broadcast({ t: 'snapshot', agents: agents.snapshot(), configs: agents.configs(), children: agents.children(), git });
        await readGit();
      } else if (m.t === 'chat-history') {
        ws.send(JSON.stringify({ t: 'chat-history', agent: m.agent, cwd: agents.cwd, request: m.request, conversations: agents.chatHistory(m.agent) }));
      } else if (m.t === 'chat-reopen') {
        agents.reopenChat(m.agent, m.id, m.cwd);
        broadcast({ t: 'snapshot', agents: agents.snapshot(), configs: agents.configs(), children: agents.children(), git });
        ws.send(JSON.stringify({ t: 'chat-reopened', agent: m.agent, id: m.id }));
      } else if (m.t === 'addagent' || m.t === 'removeagent') {
        if (m.t === 'addagent') agents.add(m.config || {}); else agents.remove(m.agent);
        broadcast({ t: 'snapshot', agents: agents.snapshot(), configs: agents.configs(), children: agents.children(), git });
      } else if (typeof m.agent === 'string') {
        if (m.t === 'send' && (typeof m.text !== 'string' || m.text.length > MAX_TEXT)) return;
        await agents.action(m);
        if (m.t === 'newchat') broadcast({ t: 'snapshot', agents: agents.snapshot(), configs: agents.configs(), children: agents.children(), git });
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: 'notice', text: e.message }));
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
