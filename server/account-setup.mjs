// First-run account setup, all from the UI: for each provider, install its CLI if it is missing (with the vendor's own installer, or by
// downloading the program), start its browser sign-in, and notice when the sign-in is finished. Nothing here runs anything the user typed:
// every command and address comes from the fixed list below.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** The accounts offered, in the order shown. `login` is how the sign-in runs: 'browser' (Tandem starts it and the CLI opens the browser) or 'terminal' (the CLI needs a real terminal window). */
export const PROVIDERS = {
  claude: {
    name: 'Claude', account: 'Claude account', about: 'Anthropic’s Claude. Sign in with your Claude subscription.', login: 'browser',
    install: { from: 'claude.ai', win32: 'irm https://claude.ai/install.ps1 | iex', unix: 'curl -fsSL https://claude.ai/install.sh | bash' },
  },
  codex: {
    name: 'ChatGPT', account: 'ChatGPT account', about: 'OpenAI’s Codex. Sign in with your ChatGPT plan.', login: 'browser',
    install: { from: 'github.com/openai/codex', download: true },
  },
  antigravity: {
    name: 'Google', account: 'Google account', about: 'Google’s Antigravity and Gemini models. Sign in with your Google account.', login: 'terminal',
    install: { from: 'antigravity.google', win32: 'irm https://antigravity.google/cli/install.ps1 | iex' },
  },
};

/** The release file of the Codex program for this computer, or null when it has to come another way. Pure. */
export function codexAsset(platform, arch) {
  if (platform !== 'win32') return null;
  const a = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  return a ? `codex-${a}-pc-windows-msvc.exe.zip` : null;
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/;
const tail = (text, n = 400) => String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim().slice(-n);

export function createAccountSetup({
  connect, specs, clis, refresh, emit = () => {}, platform = process.platform, arch = process.arch, home = os.homedir(),
  spawnImpl = spawn, fetchImpl = globalThis.fetch, pollMs = 2500, giveUpMs = 6 * 60 * 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
}) {
  const work = new Map(); // id -> { phase, step, percent, url, error, child, cancelled }
  const view = (id) => { const w = work.get(id) || {}; return { phase: w.phase || 'idle', step: w.step || '', percent: w.percent ?? null, url: w.url || '', error: w.error || '' }; };
  const publish = (id) => emit({ t: 'setup', provider: { id, ...view(id) } });
  const set = (id, patch) => { work.set(id, { ...(work.get(id) || {}), ...patch }); publish(id); };

  /** Every provider with what is installed and signed in right now, plus what Tandem is doing for it. */
  async function state() {
    const { clis: found } = await connect.status();
    return Object.entries(PROVIDERS).map(([id, p]) => {
      const c = found.find((x) => x.id === id) || {};
      return { id, name: p.name, account: p.account, about: p.about, from: p.install.from, installed: !!c.installed, signedIn: c.signedIn === true, canInstall: canInstall(id), ...view(id) };
    });
  }

  function canInstall(id) {
    const i = PROVIDERS[id]?.install;
    if (!i) return false;
    if (i.download) return !!codexAsset(platform, arch) || !!clis[id]?.pkg;
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

  /** Download the Codex program from its releases page and put it where Tandem looks for programs. */
  async function downloadCodex(id) {
    const asset = codexAsset(platform, arch);
    if (!asset) throw new Error('No download for this computer.');
    const url = `https://github.com/openai/codex/releases/latest/download/${asset}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-codex-'));
    const zip = path.join(dir, asset);
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`The download failed (HTTP ${res.status}).`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      const out = fs.createWriteStream(zip);
      for await (const chunk of res.body) {
        if (work.get(id)?.cancelled) throw new Error('Cancelled.');
        got += chunk.length; out.write(chunk);
        if (total) set(id, { percent: Math.round((got / total) * 100), step: `Downloading ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB` });
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      set(id, { percent: null, step: 'Unpacking…' });
      await runScript(id, `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`);
      const exe = fs.readdirSync(dir).find((f) => /^codex-.*\.exe$/.test(f));
      if (!exe) throw new Error('The download did not contain the program.');
      const bin = path.join(home, '.local', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.copyFileSync(path.join(dir, exe), path.join(bin, 'codex.exe'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  async function installIt(id) {
    const i = PROVIDERS[id].install;
    set(id, { phase: 'installing', step: `Getting it from ${i.from}…`, percent: null, error: '', url: '' });
    if (i.download && codexAsset(platform, arch)) await downloadCodex(id);
    else if (i.download) { // no direct download here: npm, when this computer has it
      connect.install(id);
      throw new Error('Installing with npm. Reopen this when it has finished.');
    } else await runScript(id, platform === 'win32' ? i.win32 : i.unix);
    refresh();
    if (!specs[id]) throw new Error('The installer finished but the program was not found afterwards. Restart Tandem and try again.');
  }

  /** Start the sign-in. For a browser sign-in the CLI opens the browser itself; its printed address is kept in case it did not. */
  function startLogin(id) {
    const p = PROVIDERS[id];
    if (p.login === 'terminal') { connect.login(id); set(id, { step: 'A window opened. Sign in there, and Tandem will notice.' }); return; }
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
      if (!specs[id]) await installIt(id);
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
