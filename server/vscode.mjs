// VS Code inside Tandem. The user's own VS Code can serve its full editor (extensions, terminal, debugger) to a
// browser with `code serve-web`. Tandem starts that once, on demand, and passes it through its own address under
// /vscode, so the editor loads in a panel from the same origin as the rest of the UI (VS Code refuses to be framed by
// any other origin). Nothing is bundled: no VS Code on this computer means no embedded editor.
//
// Starting it accepts Microsoft's VS Code Server license terms, so it only ever starts when the user asks for it.
// VS Code downloads its server component from Microsoft on first use and guards every request with a connection token.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

export const BASE = '/vscode';

/** The VS Code command-line program that has `serve-web`, or null. */
export function findVscodeCli({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.TANDEM_VSCODE_CLI) return exists(env.TANDEM_VSCODE_CLI) ? env.TANDEM_VSCODE_CLI : null;
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    for (const root of roots) for (const name of ['Microsoft VS Code', 'Microsoft VS Code Insiders']) {
      const file = path.join(root, name, 'bin', 'code-tunnel.exe');
      if (exists(file)) return file;
    }
    return null;
  }
  for (const name of ['code', 'code-insiders']) {
    try { const file = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (file) return file; } catch { /* not on PATH */ }
  }
  return null;
}

/** A folder on disk as the `folder` value VS Code's web UI expects: forward slashes, a leading slash, and a lower-case drive letter. */
export function folderParam(dir) {
  let p = String(dir).replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(p)) p = '/' + p[0].toLowerCase() + p.slice(1);
  return p;
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/**
 * `dataDir` is where VS Code keeps this editor's settings and extensions (separate from the desktop app's).
 * `find`, `spawnImpl` and `pickPort` are injectable for tests.
 */
export function createVscode({ dataDir, find = findVscodeCli, spawnImpl = spawn, pickPort = freePort, log = () => {} }) {
  let proc = null;
  let starting = null;
  let live = null; // { port, token }
  let lastError = '';

  /**
   * The connection token is made once and kept with the editor's data. VS Code's page reads it back from a cookie that
   * lasts for weeks, so a token that changed on every start would leave the browser holding old ones and failing to connect.
   */
  function savedToken() {
    const file = path.join(dataDir, 'connection-token');
    try { const t = fs.readFileSync(file, 'utf8').trim(); if (/^[a-f0-9]{48}$/.test(t)) return t; } catch { /* first start */ }
    const token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(file, token, { mode: 0o600 });
    return token;
  }

  async function start() {
    if (live) return live;
    if (starting) return starting;
    const cli = find();
    if (!cli) throw new Error('VS Code was not found on this computer. Install it from code.visualstudio.com, then try again.');
    starting = (async () => {
      const port = await pickPort();
      fs.mkdirSync(dataDir, { recursive: true });
      const token = savedToken();
      const args = ['serve-web', '--host', '127.0.0.1', '--port', String(port), '--connection-token', token, '--accept-server-license-terms', '--server-base-path', BASE, '--server-data-dir', dataDir];
      const child = spawnImpl(cli, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
      proc = child;
      lastError = '';
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('VS Code did not start within 30 seconds.')), 30000);
        let out = '';
        const feed = (d) => { out = (out + d).slice(-4000); if (/Web UI available/i.test(out)) { clearTimeout(timer); resolve(); } };
        child.stdout?.on('data', feed);
        child.stderr?.on('data', feed);
        child.once('error', (e) => { clearTimeout(timer); reject(new Error(`Could not start VS Code: ${e.message}`)); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`VS Code stopped while starting${code ? ` (exit ${code})` : ''}. ${out.trim().split('\n').pop() || ''}`.trim())); });
      });
      child.once('exit', () => { if (proc === child) { proc = null; live = null; } });
      child.stdout?.on('data', (d) => log(String(d)));
      live = { port, token };
      return live;
    })().catch((e) => { lastError = e.message; try { proc?.kill(); } catch { /* already gone */ } proc = null; live = null; throw e; }).finally(() => { starting = null; });
    return starting;
  }

  function stop() {
    const child = proc;
    proc = null; live = null;
    if (!child) return;
    try {
      if (process.platform === 'win32' && child.pid) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); // the editor's own server is a child of this process
      else child.kill();
    } catch { /* already gone */ }
  }

  /**
   * The editor's own token cookie outlives a run, so a browser can hold an old one (and send it first), and VS Code then
   * rejects the request. Tandem therefore keeps its own mark: a browser that has shown the current token once (in the
   * address the panel loads) gets the cookie `tandem-vscode`, and every request carrying that mark, or the current
   * token itself, is passed on with exactly the current token. Anything else is passed on untouched, for VS Code to refuse.
   */
  const MARK = 'tandem-vscode';
  function cookies(header) {
    if (!live || typeof header !== 'string') return header;
    const parts = header.split(';').map((c) => c.trim()).filter(Boolean);
    if (!parts.includes(`${MARK}=${live.token}`) && !parts.includes(`vscode-tkn=${live.token}`)) return header;
    return [...parts.filter((c) => !c.startsWith('vscode-tkn=')), `vscode-tkn=${live.token}`].join('; ');
  }
  /** True when the address itself carries the current token (the first load of the panel). */
  const shownToken = (url) => { try { return !!live && new URL(url, 'http://x').searchParams.get('tkn') === live.token; } catch { return false; } };

  const gone = (res, text) => { if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };

  /** Pass one HTTP request under /vscode through to the editor, with the browser's own Host header (see upgrade). */
  function proxy(req, res) {
    if (!live) return gone(res, 'The embedded VS Code is not running. Open the VS Code panel in Tandem to start it.');
    const first = shownToken(req.url);
    const upstream = http.request({ host: '127.0.0.1', port: live.port, method: req.method, path: req.url, headers: { ...req.headers, ...(req.headers.cookie ? { cookie: cookies(first ? `${req.headers.cookie}; ${MARK}=${live.token}` : req.headers.cookie) } : {}) } }, (answer) => {
      for (const name of ['x-content-type-options', 'referrer-policy', 'cache-control']) res.removeHeader(name); // the editor sets its own caching; Tandem's no-store would make it reload everything
      const headers = { ...answer.headers };
      if (first) headers['set-cookie'] = [...[].concat(headers['set-cookie'] || []), `${MARK}=${live.token}; Path=${BASE}; SameSite=Strict; HttpOnly`];
      res.writeHead(answer.statusCode || 502, headers);
      answer.pipe(res);
    });
    upstream.on('error', () => gone(res, 'The embedded VS Code is not answering.'));
    req.pipe(upstream);
  }

  /** Pass a WebSocket upgrade under /vscode through, byte for byte. */
  function upgrade(req, socket, head) {
    if (!live) { socket.destroy(); return; }
    const upstream = net.connect(live.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      // Host and Origin go through as the browser sent them: VS Code builds the addresses its page connects to from Host,
      // so they must stay Tandem's own (Tandem has already checked both).
      for (let k = 0; k < req.rawHeaders.length; k += 2) lines.push(`${req.rawHeaders[k]}: ${/^cookie$/i.test(req.rawHeaders[k]) ? cookies(req.rawHeaders[k + 1]) : req.rawHeaders[k + 1]}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const end = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', end); socket.on('error', end);
  }

  return {
    start, stop, proxy, upgrade, cookies,
    available: () => !!find(),
    running: () => !!live,
    lastError: () => lastError,
    /** The address of the editor for one folder, relative to Tandem's own origin. */
    url(dir) { return live ? `${BASE}/?tkn=${live.token}&folder=${encodeURIComponent(folderParam(dir)).replaceAll('%2F', '/')}` : null; },
    handles: (pathname) => pathname === BASE || pathname.startsWith(BASE + '/'),
  };
}

export const defaultDataDir = (root) => path.join(root || os.homedir(), '.tandem', 'vscode');
