import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createAccountSetup, codexPlatform, codexTarball, PROVIDERS } from '../server/account-setup.mjs';
import { codexTriple } from '../server/app/binaries.mjs';

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
  const execImpl = (file, args, opts, cb) => cb(null, 'tool 1.2.3'); // every installed program answers --version
  const setup = createAccountSetup({ connect, specs, clis: CLIS, refresh: () => {}, emit: (m) => events.push(m), platform, spawnImpl, execImpl, pollMs: 1, giveUpMs: 400, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  return { setup, specs, spawned, events, signedIn };
}

test('the assets and installers are fixed, known ones', () => {
  assert.equal(codexTarball('0.169.0', 'win32', 'x64'), 'https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-win32-x64.tgz');
  assert.equal(codexPlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(codexPlatform('freebsd', 'x64'), null);
  assert.equal(codexTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
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

// A stand-in for the npm registry: the real package layout (package/vendor/<triple>/bin/codex) in a real .tgz, unpacked by the real tar.
function fakeRegistry(dir, { withProgram = true } = {}) {
  const bin = path.join(dir, 'package', 'vendor', codexTriple(), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (withProgram) fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex'), 'program');
  fs.mkdirSync(path.join(dir, 'package', 'vendor', codexTriple(), 'codex-resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package', 'vendor', codexTriple(), 'codex-resources', 'helper.txt'), 'helper');
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', ['-czf', 'codex.tgz', 'package'], { cwd: dir });
  const bytes = fs.readFileSync(path.join(dir, 'codex.tgz'));
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.endsWith('/latest')) return { ok: true, json: async () => ({ version: '9.9.9' }) };
    return { ok: true, headers: { get: () => String(bytes.length) }, body: Readable.from([bytes.subarray(0, 100), bytes.subarray(100)]) };
  };
  return { fetchImpl, asked };
}

function codexHarness({ runs = true, withProgram = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-setup-test-'));
  const tools = path.join(root, 'tools'); const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const exe = path.join(tools, 'codex', 'vendor', codexTriple(), 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  const specs = { codex: null };
  const refresh = () => { specs.codex = fs.existsSync(exe) ? { file: exe, args: [] } : null; };
  const reg = fakeRegistry(fs.mkdtempSync(path.join(root, 'reg-')), { withProgram });
  const ran = [];
  const execImpl = (file, args, opts, cb) => { if (/tar(\.exe)?$/.test(file)) return execFile(file, args, opts, cb); ran.push([path.basename(file), ...args]); cb(runs ? null : new Error('exit 2'), runs ? 'codex-cli 9.9.9' : "error: unexpected argument 'exec'"); };
  const connect = { status: async () => ({ clis: [{ id: 'codex', installed: !!specs.codex, working: !!specs.codex, signedIn: !!specs.codex }] }), signedIn: async () => !!specs.codex };
  const setup = createAccountSetup({ connect, specs, clis: { codex: { login: ['login'] } }, refresh, tools, home, fetchImpl: reg.fetchImpl, execImpl, emit: () => {}, pollMs: 1, giveUpMs: 50 });
  return { setup, exe, home, tools, ran, asked: reg.asked, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Codex is installed without npm: the official package file is downloaded, unpacked with its helpers, and checked before use', async () => {
  const h = codexHarness();
  await h.setup.begin('codex');
  assert.deepEqual(h.asked, ['https://registry.npmjs.org/@openai/codex/latest', codexTarball('9.9.9', process.platform, process.arch)]);
  assert.ok(fs.existsSync(h.exe)); assert.ok(fs.existsSync(path.join(h.tools, 'codex', 'vendor', codexTriple(), 'codex-resources', 'helper.txt')));
  assert.ok(h.ran.some((r) => r.includes('exec') && r.includes('--help')), 'it is run once to prove it is the real program');
  assert.equal((await h.setup.state()).find((p) => p.id === 'codex').phase, 'done');
  h.done();
});

test('a Codex download that does not run is removed and reported, and a wrong program left by an older setup is taken away', async () => {
  const h = codexHarness({ runs: false });
  const old = path.join(h.home, '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.writeFileSync(old, 'wrong program');
  await h.setup.begin('codex');
  const st = (await h.setup.state()).find((p) => p.id === 'codex');
  assert.equal(st.phase, 'error'); assert.match(st.error, /did not start/);
  assert.equal(fs.existsSync(h.exe), false); assert.equal(fs.existsSync(old), false);
  h.done();
  const empty = codexHarness({ withProgram: false }); await empty.setup.begin('codex');
  assert.equal((await empty.setup.state()).find((p) => p.id === 'codex').phase, 'error');
  empty.done();
});

test('a program that is there but is not the real CLI counts as not installed, so Connect repairs it', async () => {
  const h = harness({ installed: { claude: true } });
  const st = await createAccountSetup({ connect: { status: async () => ({ clis: [{ id: 'claude', installed: true, working: false, signedIn: true }] }) }, specs: h.specs, clis: CLIS, refresh: () => {} }).state();
  assert.equal(st.find((p) => p.id === 'claude').installed, false); assert.equal(st.find((p) => p.id === 'claude').signedIn, false);
});
