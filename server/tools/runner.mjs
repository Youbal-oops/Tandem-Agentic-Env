// Build, test and dev-server commands for an agent, run in that agent's own folder. Only the scripts named in the
// project's package.json can be started (no free-form shell: agents already have their own shell tool, this is the
// structured, visible way to run the project), and the output that comes back is capped.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree } from '../agents/util.mjs';

const MAX_OUTPUT = 12000; // characters kept from the end of a run
const RUN_MS = 120000;
const RUN_MAX_MS = 600000;
const SERVER_WAIT_MS = 30000;
const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+[^\s'")]*/i;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,59}$/;
const ANSI = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

/** The package manager this folder uses, judged by its lock file. */
export function packageManager(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** The scripts in package.json, as `[{ name, command }]`. Empty when there is none. */
export function projectScripts(cwd) {
  try {
    const scripts = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts;
    return Object.entries(scripts && typeof scripts === 'object' ? scripts : {}).filter(([name, command]) => SCRIPT_NAME.test(name) && typeof command === 'string').map(([name, command]) => ({ name, command: command.slice(0, 200) }));
  } catch { return []; }
}

const tail = (s, n = MAX_OUTPUT) => (s.length > n ? `… (${s.length - n} earlier characters left out)\n${s.slice(-n)}` : s);

export function createRunner() {
  const servers = new Map(); // agent id -> { proc, script, url, output }

  /** Start `<pm> run <script>` and hand back the process. */
  function start(cwd, script, args) {
    const pm = packageManager(cwd);
    const list = pm === 'yarn' ? [script, ...args] : ['run', script, ...(args.length ? ['--', ...args] : [])];
    // npm, pnpm and yarn are .cmd shims on Windows, which need a shell. The script name was checked against a strict pattern.
    return spawn(pm, list, { cwd, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' } });
  }

  function checkScript(cwd, script) {
    if (typeof script !== 'string' || !SCRIPT_NAME.test(script)) throw new Error('Give the name of a script from package.json.');
    const names = projectScripts(cwd).map((s) => s.name);
    if (!names.includes(script)) throw new Error(`No script "${script}" in package.json.${names.length ? ` Available: ${names.join(', ')}.` : ' This folder has no package.json scripts.'}`);
  }
  const cleanArgs = (args) => (Array.isArray(args) ? args.filter((a) => typeof a === 'string' && a.length < 200 && !/[\r\n\0]/.test(a)).slice(0, 10) : []);

  /** Run a script to the end (or until the time limit) and return what it printed. */
  async function run(cwd, script, { args, timeoutSec } = {}) {
    checkScript(cwd, script);
    const limit = Math.min(RUN_MAX_MS, Math.max(1000, (Number(timeoutSec) || 0) * 1000 || RUN_MS));
    return new Promise((resolve) => {
      const started = Date.now();
      let out = '', timedOut = false;
      const proc = start(cwd, script, cleanArgs(args));
      const add = (d) => { out = (out + d).slice(-MAX_OUTPUT * 2); };
      proc.stdout.on('data', add); proc.stderr.on('data', add);
      const timer = setTimeout(() => { timedOut = true; killTree(proc); }, limit);
      const done = (exitCode, extra = '') => { clearTimeout(timer); resolve({ exitCode, timedOut, ms: Date.now() - started, output: tail((out + extra).replace(ANSI, '')) }); };
      proc.on('error', (e) => done(null, `\nCould not start: ${e.message}`));
      proc.on('close', (code) => done(code));
    });
  }

  /** Start a long-running script (a dev server) and wait until it prints a local address. One per agent. */
  async function startServer(id, cwd, script, { args } = {}) {
    checkScript(cwd, script);
    if (servers.has(id)) throw new Error(`A dev server is already running (${servers.get(id).script}${servers.get(id).url ? ' at ' + servers.get(id).url : ''}). Stop it first.`);
    const proc = start(cwd, script, cleanArgs(args));
    const s = { proc, script, url: null, output: '', exited: null };
    servers.set(id, s);
    const add = (d) => { s.output = (s.output + String(d).replace(ANSI, '')).slice(-MAX_OUTPUT * 2); s.url ||= s.output.match(URL_IN_OUTPUT)?.[0]?.replace('0.0.0.0', 'localhost') || null; };
    proc.stdout.on('data', add); proc.stderr.on('data', add);
    proc.on('close', (code) => { s.exited = code; if (servers.get(id) === s) servers.delete(id); });
    proc.on('error', (e) => { s.output += `\nCould not start: ${e.message}`; s.exited = -1; servers.delete(id); });
    const end = Date.now() + SERVER_WAIT_MS;
    while (!s.url && s.exited === null && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
    if (s.exited !== null) throw new Error(`The script exited with code ${s.exited} before it was ready.\n${tail(s.output, 3000)}`);
    return { script, url: s.url, ready: !!s.url, output: tail(s.output, 3000), note: s.url ? undefined : `No local address was printed within ${SERVER_WAIT_MS / 1000}s; it may still be starting. Use dev_server_status.` };
  }

  function serverStatus(id) {
    const s = servers.get(id);
    return s ? { running: true, script: s.script, url: s.url, output: tail(s.output, 3000) } : { running: false };
  }

  function stopServer(id) {
    const s = servers.get(id);
    if (!s) return { stopped: false };
    servers.delete(id);
    killTree(s.proc);
    return { stopped: true, script: s.script };
  }

  return { scripts: projectScripts, packageManager, run, startServer, serverStatus, stopServer, closeAll() { for (const id of [...servers.keys()]) stopServer(id); } };
}
