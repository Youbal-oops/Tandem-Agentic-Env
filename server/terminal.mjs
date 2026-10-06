// A small command-line terminal for one browser connection.
//
// Each line you type runs in the system shell (PowerShell on Windows, $SHELL or sh elsewhere) in the
// terminal's folder, and its output streams back. `cd` is handled here so the folder sticks between
// commands. While a command runs, lines you type go to its stdin. This is a pipe, not a PTY: full-screen
// programs (vim, htop) and programs that insist on a real terminal will not work.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_LINE = 8000;
const FLUSH_MS = 30;
const MAX_CHUNK = 64 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024; // per command; a runaway process is stopped, not allowed to flood the browser

const CD = /^(?:cd|chdir|sl|set-location)(?:\s+(?:\/d\s+)?(.*))?$/i;
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');

function shellCommand(line) {
  if (process.platform === 'win32') {
    // PowerShell reports 1 for any failure, so pass a native program's real exit code through.
    const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'\n${line}\n$tandemOk = $?; $tandemCode = $LASTEXITCODE; if ($tandemCode) { exit $tandemCode }; if (-not $tandemOk) { exit 1 }`;
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
  }
  return { file: process.env.SHELL || '/bin/sh', args: ['-c', line] };
}

function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} } }
}

/** Environment for terminal commands: the user's own, minus Tandem's private delegation settings. */
function terminalEnv() {
  const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
  for (const k of Object.keys(env)) if (k.startsWith('TANDEM_')) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function createTerminal({ cwd, emit, spawnImpl = spawn }) {
  let dir = path.resolve(cwd);
  let proc = null;
  let buffer = '';
  let timer = null;
  let sent = 0;
  let capped = false;
  let closed = false;

  const out = (msg) => { if (!closed) emit({ t: 'term', ...msg }); };
  const state = () => ({ cwd: dir, running: !!proc });
  function flush() {
    clearTimeout(timer); timer = null;
    while (buffer) { out({ kind: 'out', text: buffer.slice(0, MAX_CHUNK) }); buffer = buffer.slice(MAX_CHUNK); }
  }
  function data(chunk, kind = 'out') {
    if (capped) return;
    sent += chunk.length;
    if (sent > MAX_OUTPUT) { capped = true; flush(); killTree(proc); out({ kind: 'err', text: '\n[stopped: this command printed more than 16 MB]\n' }); return; }
    if (kind === 'err') { flush(); out({ kind: 'err', text: chunk }); return; }
    buffer += chunk;
    if (buffer.length >= MAX_CHUNK) flush(); else if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }

  function changeDir(target) {
    const next = target ? path.resolve(dir, unquote(target).replace(/^~(?=$|[\\/])/, () => os.homedir())) : os.homedir();
    let ok = false;
    try { ok = fs.statSync(next).isDirectory(); } catch {}
    if (!ok) { out({ kind: 'err', text: `cd: no such folder: ${next}\n` }); return; }
    dir = next; out({ kind: 'cwd', ...state() });
  }

  return {
    state,
    /** Jump to a folder (used when the user picks another worktree). Ignored while a command runs. */
    chdir(target) { if (!closed && !proc) changeDir(target); },
    /** Run a line, or send it to the running command's stdin. */
    run(line) {
      if (closed) return;
      line = String(line ?? '');
      if (line.length > MAX_LINE) { out({ kind: 'err', text: `That line is longer than ${MAX_LINE} characters.\n` }); return; }
      if (proc) { if (proc.stdin?.writable) proc.stdin.write(line + '\n'); return; }
      const trimmed = line.trim();
      if (!trimmed) { out({ kind: 'done', ...state() }); return; }
      const cd = CD.exec(trimmed);
      if (cd) { changeDir(cd[1] || ''); out({ kind: 'done', ...state() }); return; }
      const { file, args } = shellCommand(trimmed);
      sent = 0; capped = false;
      let child;
      try {
        child = spawnImpl(file, args, { cwd: dir, env: terminalEnv(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) { out({ kind: 'err', text: `Could not start the shell: ${e.message}\n` }); out({ kind: 'done', ...state() }); return; }
      proc = child;
      out({ kind: 'start', ...state() });
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d) => data(d));
      child.stderr?.on('data', (d) => data(d, 'err'));
      child.stdin?.on('error', () => {});
      let finished = false;
      const finish = (code, signal) => {
        if (finished) return; finished = true;
        flush();
        if (proc === child) proc = null;
        out({ kind: 'done', code, signal, ...state() });
      };
      child.on('error', (e) => { out({ kind: 'err', text: `${e.message}\n` }); finish(null, null); });
      child.on('close', finish);
    },
    /** Ctrl+C: stop the running command and everything it started. */
    interrupt() { if (proc) { killTree(proc); out({ kind: 'err', text: '^C\n' }); } },
    close() { closed = true; clearTimeout(timer); if (proc) killTree(proc); proc = null; },
  };
}
