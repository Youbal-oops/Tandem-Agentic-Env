// Connecting agent CLIs from inside Tandem: what is installed, install it with npm, and open a real
// terminal window already running the CLI's sign-in. Nothing here runs a command the user typed: the
// package names and sign-in commands come from the fixed list in app/binaries.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The command that opens a terminal window and runs `file args…` in it. Pure, so it can be tested. */
export function terminalLaunch(platform, file, args = []) {
  if (platform === 'win32') {
    const script = `& ${[file, ...args].map(q).join(' ')}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', `Start-Process powershell.exe -ArgumentList '-NoExit','-NoProfile','-EncodedCommand','${encoded}'`] };
  }
  const line = [file, ...args].map((s) => `'${String(s).replace(/'/g, "'\\''")}'`).join(' ');
  if (platform === 'darwin') {
    const esc = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { cmd: 'osascript', args: ['-e', `tell application "Terminal" to activate`, '-e', `tell application "Terminal" to do script "${esc}"`] };
  }
  return { cmd: 'x-terminal-emulator', args: ['-e', 'sh', '-c', `${line}; exec "\${SHELL:-sh}"`] };
}

/**
 * `specs` and `clis` come from app/binaries.mjs, `refresh()` re-detects after an install, and `emit(msg)` reaches
 * every browser. The process helpers are injectable for tests.
 */
export function createConnect({ specs, clis, refresh, emit, home = os.homedir(), platform = process.platform, spawnImpl = spawn, execImpl = execFile }) {
  let installing = null;

  const npm = platform === 'win32' ? { file: 'npm.cmd', shell: true } : { file: 'npm', shell: false };
  // On Windows a .cmd file only runs through a shell (Node refuses to spawn it directly).
  const run = (file, args, timeout = 10000) => new Promise((resolve) => {
    const viaShell = file === npm.file && npm.shell;
    // Fixed words only, joined into one command line so Node has no argument list to warn about.
    const [f, a] = viaShell ? [[file, ...args].join(' '), []] : [file, args];
    execImpl(f, a, { timeout, windowsHide: true, encoding: 'utf8', shell: viaShell }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout || '') + String(stderr || '') }));
  });

  async function signedIn(id) {
    const cli = clis[id];
    if (!specs[id]) return null;
    if (cli.status) return (await run(specs[id].file, [...specs[id].args, ...cli.status])).ok;
    // Gemini has no status command: an API key in the environment, or the file its Google sign-in leaves behind.
    return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json')));
  }

  async function status() {
    const npmCheck = await run(npm.file, ['--version'], 8000).then((r) => r.ok).catch(() => false);
    const list = await Promise.all(Object.entries(clis).map(async ([id, cli]) => {
      const spec = specs[id];
      let version = '';
      if (spec) version = (await run(spec.file, [...spec.args, '--version'], 8000)).out.trim().split('\n').pop().slice(0, 40);
      return { id, name: cli.name, pkg: cli.pkg, installed: !!spec, version, signedIn: await signedIn(id), installing: installing === id };
    }));
    return { clis: list, npm: npmCheck, installing };
  }

  const known = (id) => (typeof id === 'string' && Object.hasOwn(clis, id) ? clis[id] : null);

  function install(id) {
    const cli = known(id);
    if (!cli) throw new Error('Unknown agent.');
    if (installing) throw new Error(`Still installing ${clis[installing].name}. Wait for it to finish.`);
    installing = id;
    const out = (kind, text) => emit({ t: 'connect-install', cli: id, kind, text });
    out('out', `$ npm install -g ${cli.pkg}\n`);
    const words = ['install', '-g', cli.pkg, '--no-fund', '--no-audit']; // cli.pkg is from the fixed list, never user input
    const proc = npm.shell
      ? spawnImpl([npm.file, ...words].join(' '), [], { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnImpl(npm.file, words, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let sent = 0;
    const feed = (d) => { if (sent < 200000) { sent += d.length; out('out', String(d)); } };
    proc.stdout?.on('data', feed);
    proc.stderr?.on('data', feed);
    proc.on('error', (e) => { installing = null; out('done', `Could not run npm: ${e.message}. Install Node.js from nodejs.org, then try again.`); emit({ t: 'connect-changed' }); });
    proc.on('exit', (code) => {
      installing = null;
      refresh();
      const ok = code === 0 && !!specs[id];
      out('done', ok ? `${cli.name} is installed.` : code === 0 ? `npm finished but ${cli.name} was not found afterwards. Restart Tandem so it picks up the new PATH.` : `npm exited with code ${code}. The log above says why; a permissions error usually means the npm folder needs admin rights.`);
      emit({ t: 'connect-changed' });
    });
    return { started: true };
  }

  function login(id) {
    const cli = known(id);
    if (!cli) throw new Error('Unknown agent.');
    const spec = specs[id];
    if (!spec) throw new Error(`${cli.name} is not installed yet. Install it first.`);
    const { cmd, args } = terminalLaunch(platform, spec.file, [...spec.args, ...cli.login]);
    const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on?.('error', () => emit({ t: 'notice', text: 'Could not open a terminal window. Run the sign-in command yourself in any terminal.' }));
    child.unref?.();
    return { opened: true };
  }

  return { status, install, login };
}
