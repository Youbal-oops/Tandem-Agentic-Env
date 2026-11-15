// First-run account setup, all from the UI: for each provider, install its CLI if it is missing (with the vendor's own installer, or by
// downloading the program), start its browser sign-in, and notice when the sign-in is finished. Nothing here runs anything the user typed:
// every command and address comes from the fixed list below.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

/** The accounts offered, in the order shown. `login` is how the sign-in runs: 'browser' (Tandem starts it and the CLI opens the browser) or 'terminal' (the CLI needs a real terminal window). */
export const PROVIDERS = {
  claude: {
    name: 'Claude', account: 'Claude account', about: 'Anthropic’s Claude. Sign in with your Claude subscription.', login: 'browser',
    install: { from: 'claude.ai', win32: 'irm https://claude.ai/install.ps1 | iex', unix: 'curl -fsSL https://claude.ai/install.sh | bash' },
  },
  codex: {
    name: 'ChatGPT', account: 'ChatGPT account', about: 'OpenAI’s Codex. Sign in with your ChatGPT plan.', login: 'browser',
    install: { from: 'npmjs.org (OpenAI’s official package)', download: true },
  },
  antigravity: {
    name: 'Google', account: 'Google account', about: 'Google’s Antigravity and Gemini models. Sign in with your Google account.', login: 'terminal',
    install: { from: 'antigravity.google', win32: 'irm https://antigravity.google/cli/install.ps1 | iex' },
  },
};

/** The npm name for this kind of computer in Codex's per-platform packages, or null. Pure. */
export function codexPlatform(platform, arch) {
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) return null;
  return `${platform}-${arch}`;
}
/** Where the official Codex package for this computer is downloaded from. Pure. */
export const codexTarball = (version, platform, arch) => `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${codexPlatform(platform, arch)}.tgz`;

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/;
const tail = (text, n = 400) => String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim().slice(-n);

export function createAccountSetup({
  connect, specs, clis, refresh, emit = () => {}, onConnected = () => {}, platform = process.platform, arch = process.arch, home = os.homedir(), tools = path.join(os.homedir(), '.tandem', 'tools'),
  spawnImpl = spawn, execImpl = execFile, fetchImpl = globalThis.fetch, pollMs = 2500, giveUpMs = 6 * 60 * 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
}) {
  const work = new Map(); // id -> { phase, step, percent, url, error, child, cancelled }
  const view = (id) => { const w = work.get(id) || {}; return { phase: w.phase || 'idle', step: w.step || '', percent: w.percent ?? null, url: w.url || '', error: w.error || '' }; };
  const publish = (id) => emit({ t: 'setup', provider: { id, ...view(id) } });
  const set = (id, patch) => { work.set(id, { ...(work.get(id) || {}), ...patch }); publish(id); };

  /** Every provider with what is installed and signed in right now, plus what Tandem is doing for it. */
  /** `quick` answers at once from what is already known (is the program there), marking the sign-in as still being checked. */
  async function state({ quick = false } = {}) {
    const found = quick ? Object.keys(PROVIDERS).map((id) => ({ id, installed: !!specs[id], signedIn: null })) : (await connect.status()).clis;
    return Object.entries(PROVIDERS).map(([id, p]) => {
      const c = found.find((x) => x.id === id) || {};
      return { id, name: p.name, account: p.account, about: p.about, from: p.install.from, installed: !!c.installed && c.working !== false, signedIn: c.signedIn === true && c.working !== false, checking: quick, canInstall: canInstall(id), ...view(id) };
    });
  }

  function canInstall(id) {
    const i = PROVIDERS[id]?.install;
    if (!i) return false;
    if (i.download) return !!codexPlatform(platform, arch);
    return !!(platform === 'win32' ? i.win32 : i.unix);
  }

  /** Run a vendor installer script in a hidden shell, showing its latest line as the step. */
  function runScript(id, script) {
    return new Promise((resolve, reject) => {
      const [cmd, args] = platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]] : ['sh', ['-c', script]];
      const child = spawnImpl(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      work.get(id).child = child;
      let last = '';
      const feed = (d) => { const line = tail(d, 160).split(/\r?\n/).filter(Boolean).pop(); if (line) { last = line; set(id, { step: line.slice(0, 120) }); } };
      child.stdout?.on('data', feed); child.stderr?.on('data', feed);
      child.on('error', (e) => reject(new Error(`Could not start the installer: ${e.message}`)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(work.get(id)?.cancelled ? 'Cancelled.' : `The installer stopped (code ${code}). ${last}`.trim()))));
    });
  }

  const runFile = (file, args, timeout = 120000, cwd = undefined, environment = {}) => new Promise((r) => execImpl(file, args, { timeout, windowsHide: true, encoding: 'utf8', cwd, env: { ...process.env, ...environment } }, (err, out) => r({ ok: !err, out: String(out || '') })));
  // Windows' own tar, by its full path: another tar earlier on the PATH (Git's) reads `C:` as a network host and fails.
  const tarProgram = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';

  /**
   * Codex without npm: download the official package file for this computer from the npm registry (the same file `npm install` would
   * fetch), unpack it into Tandem's own tools folder, and check that it really runs `codex exec` before using it.
   */
  async function downloadCodex(id) {
    if (!codexPlatform(platform, arch)) throw new Error('There is no Codex download for this kind of computer.');
    const meta = await fetchImpl('https://registry.npmjs.org/@openai/codex/latest');
    if (!meta.ok) throw new Error(`Could not reach the download server (HTTP ${meta.status}). Check your internet connection.`);
    const version = String((await meta.json()).version || '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The download server gave an unexpected answer.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-codex-'));
    const tgz = path.join(tmp, 'codex.tgz');
    try {
      const res = await fetchImpl(codexTarball(version, platform, arch));
      if (!res.ok) throw new Error(`The download failed (HTTP ${res.status}).`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      const out = fs.createWriteStream(tgz);
      for await (const chunk of res.body) {
        if (work.get(id)?.cancelled) { out.destroy(); throw new Error('Cancelled.'); }
        got += chunk.length; if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (total) set(id, { percent: Math.round((got / total) * 100), step: `Downloading ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB` });
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      set(id, { percent: null, step: 'Unpacking…' });
      const un = await runFile(tarProgram, ['-xzf', 'codex.tgz'], 300000, tmp); // tar comes with Windows 10 and later, macOS and Linux
      const vendor = path.join(tmp, 'package', 'vendor');
      if (!un.ok || !fs.existsSync(vendor)) throw new Error('The download could not be unpacked.');
      const dest = path.join(tools, 'codex');
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(vendor, path.join(dest, 'vendor'), { recursive: true });
      refresh();
      const spec = specs[id];
      const works = spec && (await runFile(spec.file, [...(spec.args || []), 'exec', '--help'], 20000, undefined, spec.environment)).ok;
      if (!works) { fs.rmSync(dest, { recursive: true, force: true }); refresh(); throw new Error('The downloaded Codex did not start on this computer, so it was removed.'); }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  /** A program Tandem put in place earlier that does not work (an old setup kept the wrong Codex file) is taken away so the good one is found. */
  async function removeBroken(id) {
    const old = path.join(home, '.local', 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
    if (id !== 'codex' || !fs.existsSync(old)) return;
    if (!/\d+\.\d+/.test((await runFile(old, ['--version'], 8000)).out)) fs.rmSync(old, { force: true });
  }

  async function installIt(id) {
    const i = PROVIDERS[id].install;
    set(id, { phase: 'installing', step: `Getting it from ${i.from}…`, percent: null, error: '', url: '' });
    await removeBroken(id);
    if (i.download) await downloadCodex(id);
    else await runScript(id, platform === 'win32' ? i.win32 : i.unix);
    refresh();
    if (!specs[id]) throw new Error('The installer finished but the program was not found afterwards. Restart Tandem and try again.');
  }

  /** Start the sign-in. For a browser sign-in the CLI opens the browser itself; its printed address is kept in case it did not. */
  function startLogin(id) {
    const p = PROVIDERS[id];
    if (p.login === 'terminal') { connect.login(id); set(id, { step: 'A window opened. Sign in there; if it shows a code, paste it into that window. Tandem notices when you are done.' }); return; }
    const spec = specs[id];
    const child = spawnImpl(spec.file, [...(spec.args || []), ...clis[id].login], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(spec.environment || {}) } });
    let output = '';
    const feed = (d) => { output += d; const m = String(output).match(URL_RE); if (m && !view(id).url) set(id, { url: m[0] }); };
    child.stdout?.on('data', feed); child.stderr?.on('data', feed);
    work.get(id).child = child; work.get(id).output = () => output;
    child.on('error', (e) => { work.get(id).failed = `Could not start the sign-in: ${e.message}`; });
    child.on('exit', (code) => { if (code) work.get(id).failed = work.get(id).failed || tail(output, 200) || `The sign-in stopped (code ${code}).`; });
    set(id, { phase: 'signing-in', step: 'Finish signing in in your browser…' });
  }

  async function begin(id) {
    if (!PROVIDERS[id]) throw new Error('Unknown account.');
    if (['installing', 'signing-in'].includes(view(id).phase)) return;
    work.set(id, { phase: 'installing', cancelled: false });
    try {
      set(id, { phase: 'installing', step: 'Checking…', percent: null, error: '', url: '' });
      // Missing, or there but not the real program (it cannot even say its version): install it.
      const works = !!specs[id] && /\d+\.\d+/.test((await runFile(specs[id].file, [...(specs[id].args || []), '--version'], 10000, undefined, specs[id].environment)).out);
      if (!works) await installIt(id);
      if (work.get(id).cancelled) throw new Error('Cancelled.');
      if (await connect.signedIn(id)) return finish(id);
      set(id, { phase: 'signing-in', step: 'Starting the sign-in…', percent: null });
      startLogin(id);
      const until = now() + giveUpMs;
      while (!work.get(id).cancelled && now() < until) {
        await sleep(pollMs);
        if (await connect.signedIn(id)) return finish(id);
        const w = work.get(id);
        if (w.failed) throw new Error(w.failed);
      }
      if (work.get(id).cancelled) throw new Error('Cancelled.');
      throw new Error('The sign-in was not finished. Try again when you are ready.');
    } catch (e) {
      const cancelled = work.get(id)?.cancelled;
      work.get(id)?.child?.kill?.();
      set(id, { phase: cancelled ? 'idle' : 'error', error: cancelled ? '' : e.message, step: '', percent: null, child: null });
    }
  }

  function finish(id) {
    work.get(id)?.child?.kill?.();
    refresh();
    set(id, { phase: 'done', step: '', percent: null, url: '', error: '', child: null });
    try { onConnected(id); } catch { /* the scan below still adds it */ }
    emit({ t: 'connect-changed' }); // adds the agent and updates every screen
  }

  function cancel(id) {
    const w = work.get(id);
    if (!w) return;
    w.cancelled = true; w.child?.kill?.();
    set(id, { phase: 'idle', step: '', percent: null, url: '', error: '' });
  }

  return { state, begin, cancel };
}
