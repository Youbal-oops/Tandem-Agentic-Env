import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAccountSetup, codexAsset, PROVIDERS } from '../server/account-setup.mjs';

const CLIS = { claude: { login: ['auth', 'login'], pkg: '@x/claude' }, codex: { login: ['login'], pkg: '@x/codex' }, antigravity: { login: [], pkg: '' } };

function fakeChild() { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.killed = false; c.kill = () => { c.killed = true; }; return c; }

function harness({ installed = {}, signed = {}, platform = 'win32' } = {}) {
  const specs = { claude: null, codex: null, antigravity: null, ...Object.fromEntries(Object.entries(installed).map(([k, v]) => [k, v ? { file: `${k}.exe`, args: [] } : null])) };
  const spawned = []; const events = []; const signedIn = { ...signed };
  const connect = {
    status: async () => ({ clis: Object.keys(CLIS).map((id) => ({ id, installed: !!specs[id], signedIn: specs[id] ? !!signedIn[id] : null })) }),
    signedIn: async (id) => !!signedIn[id], login: (id) => spawned.push(['terminal', id]), install: () => {},
  };
  const spawnImpl = (cmd, args) => { const c = fakeChild(); spawned.push([cmd, args, c]); return c; };
  const setup = createAccountSetup({ connect, specs, clis: CLIS, refresh: () => {}, emit: (m) => events.push(m), platform, spawnImpl, pollMs: 1, giveUpMs: 400, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  return { setup, specs, spawned, events, signedIn };
}

test('the assets and installers are fixed, known ones', () => {
  assert.equal(codexAsset('win32', 'x64'), 'codex-x86_64-pc-windows-msvc.exe.zip');
  assert.equal(codexAsset('win32', 'arm64'), 'codex-aarch64-pc-windows-msvc.exe.zip');
  assert.equal(codexAsset('linux', 'x64'), null);
  assert.match(PROVIDERS.claude.install.win32, /^irm https:\/\/claude\.ai\/install\.ps1/);
  assert.match(PROVIDERS.antigravity.install.win32, /^irm https:\/\/antigravity\.google\//);
});

test('a signed-in CLI that is installed is simply connected, with nothing started', async () => {
  const h = harness({ installed: { claude: true }, signed: { claude: true } });
  await h.setup.begin('claude');
  assert.equal(h.spawned.length, 0);
  assert.equal(h.events.at(-1).t, 'connect-changed');
  const st = (await h.setup.state()).find((p) => p.id === 'claude');
  assert.equal(st.phase, 'done'); assert.equal(st.signedIn, true);
});

test('an installed but signed-out CLI starts a hidden browser sign-in, keeps its address, and finishes when the account is signed in', async () => {
  const h = harness({ installed: { claude: true } });
  const run = h.setup.begin('claude');
  await new Promise((r) => setTimeout(r, 20));
  const [cmd, args, child] = h.spawned[0];
  assert.equal(cmd, 'claude.exe'); assert.deepEqual(args, ['auth', 'login']);
  child.stdout.write('Opening browser. If it does not open visit https://claude.ai/oauth/authorize?x=1 to continue\n');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await h.setup.state()).find((p) => p.id === 'claude').url, 'https://claude.ai/oauth/authorize?x=1');
  assert.equal((await h.setup.state()).find((p) => p.id === 'claude').phase, 'signing-in');
  h.signedIn.claude = true;
  await run;
  assert.equal(child.killed, true);
  assert.equal((await h.setup.state()).find((p) => p.id === 'claude').phase, 'done');
});

test('a missing CLI is installed with the vendor script first, then signed in', async () => {
  const h = harness();
  const run = h.setup.begin('claude');
  await new Promise((r) => setTimeout(r, 10));
  const [cmd, args, child] = h.spawned[0];
  assert.equal(cmd, 'powershell.exe'); assert.match(args.join(' '), /claude\.ai\/install\.ps1/);
  h.specs.claude = { file: 'claude.exe', args: [] }; // what refresh() finds after the install
  child.stdout.write('Installing Claude Code…\n'); child.emit('exit', 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.spawned[1][0], 'claude.exe', 'the sign-in starts right after');
  h.signedIn.claude = true; await run;
  assert.equal((await h.setup.state()).find((p) => p.id === 'claude').phase, 'done');
});

test('a failed installer, a sign-in that stops, and giving up are all shown as errors you can retry', async () => {
  const a = harness(); const run = a.setup.begin('claude');
  await new Promise((r) => setTimeout(r, 10)); a.spawned[0][2].stderr.write('boom\n'); a.spawned[0][2].emit('exit', 1); await run;
  const sa = (await a.setup.state()).find((p) => p.id === 'claude'); assert.equal(sa.phase, 'error'); assert.match(sa.error, /installer stopped/);

  const b = harness({ installed: { codex: true } }); const run2 = b.setup.begin('codex');
  await new Promise((r) => setTimeout(r, 10)); b.spawned[0][2].stderr.write('Port 1455 is in use\n'); b.spawned[0][2].emit('exit', 1); await run2;
  assert.match((await b.setup.state()).find((p) => p.id === 'codex').error, /Port 1455/);

  const c = harness({ installed: { codex: true } }); await c.setup.begin('codex');
  assert.match((await c.setup.state()).find((p) => p.id === 'codex').error, /not finished/);
});

test('Google sign-in needs a real terminal window, and cancelling stops the sign-in', async () => {
  const g = harness({ installed: { antigravity: true } });
  const run = g.setup.begin('antigravity'); await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(g.spawned[0], ['terminal', 'antigravity']);
  g.setup.cancel('antigravity'); await run;
  assert.equal((await g.setup.state()).find((p) => p.id === 'antigravity').phase, 'idle');
  const c = harness({ installed: { claude: true } }); const r2 = c.setup.begin('claude'); await new Promise((r) => setTimeout(r, 10));
  c.setup.cancel('claude'); await r2; assert.equal(c.spawned[0][2].killed, true);
});

test('where there is no installer for this system the card says so', async () => {
  const h = harness({ platform: 'linux' });
  const st = await h.setup.state();
  assert.equal(st.find((p) => p.id === 'antigravity').canInstall, false);
  assert.equal(st.find((p) => p.id === 'claude').canInstall, true);
});

import { pickCodexExe } from '../server/account-setup.mjs';
test('the Codex program is picked by its own name, never a helper that happens to sort first', () => {
  const asset = 'codex-x86_64-pc-windows-msvc.exe.zip';
  assert.equal(pickCodexExe(['codex-command-runner.exe', 'codex-x86_64-pc-windows-msvc.exe'], asset), 'codex-x86_64-pc-windows-msvc.exe');
  assert.equal(pickCodexExe(['codex.exe', 'helper.exe'], asset), 'codex.exe');
  assert.equal(pickCodexExe(['codex-command-runner.exe'], asset), null);
});
