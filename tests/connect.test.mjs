import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';
import { STARTERS } from './fixtures/starters.mjs';
import { createConnect, terminalLaunch, windowsSignIn } from '../server/connect.mjs';
import { cleanAgents } from '../server/settings.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex', 'gemini', 'antigravity'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-connect-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const w = createWorkspace({ initialAgents: STARTERS, root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast() {} });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  return w;
}

test('a Gemini planet streams messages and tools, maps tool names, and resumes its own session', async (t) => {
  const w = setup(t);
  w.add({ id: 'gem', name: 'Gem', provider: 'gemini' });
  await w.action({ t: 'send', agent: 'gem', text: 'Fix the typo' });
  await waitFor(() => !w.snapshot().gem.meta.busy && w.snapshot().gem.events.some((e) => e.k === 'turn'));
  let events = w.snapshot().gem.events;
  assert.equal(events.find((e) => e.k === 'msg').text, 'Looking at the file.');
  const tool = events.find((e) => e.k === 'tool');
  assert.equal(tool.name, 'Edit', 'replace is shown and counted as an edit');
  assert.equal(tool.cls, 'edit');
  assert.equal(tool.status, 'done');
  assert.equal(tool.summary, 'a.txt');
  const echoed = JSON.parse(events.filter((e) => e.k === 'msg').at(-1).text);
  assert.ok(echoed.args.includes('stream-json'));
  assert.deepEqual(echoed.args.slice(echoed.args.indexOf('--approval-mode'), echoed.args.indexOf('--approval-mode') + 2), ['--approval-mode', 'plan']);
  assert.match(echoed.text, /Fix the typo/);
  assert.equal(echoed.args.includes('--resume'), false);
  assert.equal(w.snapshot().gem.meta.session, true);

  await w.action({ t: 'send', agent: 'gem', text: 'And again' });
  await waitFor(() => w.snapshot().gem.events.filter((e) => e.k === 'turn').length === 2);
  events = w.snapshot().gem.events;
  const second = JSON.parse(events.filter((e) => e.k === 'msg').at(-1).text);
  assert.deepEqual(second.args.slice(second.args.indexOf('--resume'), second.args.indexOf('--resume') + 2), ['--resume', 'latest']);
});

test('full access is refused until it is allowed in Settings, then reaches Codex as no sandbox', async (t) => {
  const w = setup(t);
  assert.throws(() => w.action({ t: 'mode', agent: 'codex', mode: 'full' }), /Full access is not allowed yet/);
  w.saveSettings({ agents: { allowFull: true, pingMain: false } });
  await w.action({ t: 'mode', agent: 'codex', mode: 'full' });
  assert.equal(w.snapshot().codex.meta.mode, 'full');
  await w.action({ t: 'send', agent: 'codex', text: 'hello' });
  await waitFor(() => w.snapshot().codex.events.some((e) => e.k === 'msg'));
  const echoed = JSON.parse(w.snapshot().codex.events.find((e) => e.k === 'msg').text);
  assert.equal(echoed.args[echoed.args.indexOf('-s') + 1], 'danger-full-access');
  assert.ok(!echoed.args.includes('sandbox_workspace_write.network_access=true'), 'full access needs no sandbox setting');
  // Turning the permission off drops the agent back to a sandboxed mode.
  await waitFor(() => !w.snapshot().codex.meta.busy);
  w.saveSettings({ agents: { allowFull: false } });
  assert.equal(w.snapshot().codex.meta.mode, 'edit');
});

test('subagents can never be set to full access', async (t) => {
  const w = setup(t);
  w.saveSettings({ agents: { allowFull: true, pingMain: false } });
  const c = w.childAction({ t: 'child-create', agent: 'codex', provider: 'codex', text: 'task' });
  await waitFor(() => !w.children()[0].meta.busy);
  assert.throws(() => w.childAction({ id: c.id, action: 'mode', mode: 'full' }), /only available to main agents/);
});

test('settings clean the agent options', () => {
  assert.deepEqual(cleanAgents({ allowFull: 'yes', pingMain: false }), { pingMain: false, allowFull: false, tools: true });
  assert.equal(cleanAgents({ allowFull: true }).allowFull, true);
  assert.equal(cleanAgents({ tools: false }).tools, false, 'the tools switch can be turned off');
  assert.equal(cleanAgents({ tools: 'no' }, { pingMain: true, allowFull: false, tools: false }).tools, false, 'a bad value keeps the current one');
});

test('sign-in opens a terminal window running the CLI login, quoted for each platform', () => {
  // Windows: a script file in its own Command Prompt window (PowerShell starting PowerShell could finish with no window at all).
  const win = windowsSignIn('C:\Temp\a b\sign-in.cmd', 'C:\Program Files\agy\agy.exe', ['login', '50%'], { title: 'Sign in to Antigravity CLI', notes: ['Paste the code & press Enter'] });
  assert.equal(win.cmd, 'cmd.exe'); assert.equal(win.verbatim, true);
  assert.equal(win.args.at(-1), '"start "Sign in to Antigravity CLI" cmd.exe /k "C:\Temp\a b\sign-in.cmd""');
  assert.match(win.text, /^"C:\Program Files\agy\agy\.exe" "login" "50%%"\r$/m);
  assert.match(win.text, /^echo Paste the code  press Enter\r$/m, 'nothing in a note can run as a command');
  const mac = terminalLaunch('darwin', '/usr/local/bin/codex', ['login']);
  assert.equal(mac.cmd, 'osascript');
  assert.match(mac.args.at(-1), /do script "'\/usr\/local\/bin\/codex' 'login'"/);
  const linux = terminalLaunch('linux', '/usr/bin/gemini', []);
  assert.deepEqual(linux.args.slice(0, 3), ['-e', 'sh', '-c']);
});

function connectHarness({ installed = {}, exitCode = 0, installsOnExit = true } = {}) {
  const live = { ...installed };
  const clis = { codex: { name: 'Codex CLI', pkg: '@openai/codex', login: ['login'], status: ['login', 'status'] }, gemini: { name: 'Gemini CLI', pkg: '@google/gemini-cli', login: [], status: null } };
  const emitted = []; const spawned = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-home-'));
  const execImpl = (file, args, opts, cb) => cb(null, args.includes('--version') ? 'v1.2.3\n' : 'Logged in\n', '');
  const spawnImpl = (cmd, args, opts) => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.unref = () => {};
    spawned.push({ cmd, args, opts });
    if (cmd === 'npm' || cmd === 'npm.cmd') setTimeout(() => { p.stdout.emit('data', 'added 1 package\n'); if (installsOnExit) live.gemini = { file: 'gemini', args: [] }; p.emit('exit', exitCode); }, 10);
    return p;
  };
  const connect = createConnect({ specs: live, clis, refresh() {}, emit: (m) => emitted.push(m), home, platform: 'linux', spawnImpl, execImpl });
  return { connect, emitted, spawned, live, home };
}

test('connect status lists install state, version and sign-in', async () => {
  const { connect, home } = connectHarness({ installed: { codex: { file: 'codex', args: [] } } });
  let s = await connect.status();
  const codex = s.clis.find((c) => c.id === 'codex');
  assert.deepEqual([codex.installed, codex.version, codex.signedIn], [true, 'v1.2.3', true]);
  const gemini = s.clis.find((c) => c.id === 'gemini');
  assert.deepEqual([gemini.installed, gemini.signedIn], [false, null]);
  assert.equal(s.npm, true);
  // Gemini counts as signed in once its Google sign-in file exists.
  const { connect: c2, home: h2, live } = connectHarness({ installed: { gemini: { file: 'gemini', args: [] } } });
  assert.equal((await c2.status()).clis.find((c) => c.id === 'gemini').signedIn, false);
  fs.mkdirSync(path.join(h2, '.gemini')); fs.writeFileSync(path.join(h2, '.gemini', 'oauth_creds.json'), '{}');
  assert.equal((await c2.status()).clis.find((c) => c.id === 'gemini').signedIn, true);
  void live; void home;
});

test('install runs the fixed npm package once at a time and reports the result', async () => {
  const { connect, emitted, spawned } = connectHarness();
  connect.install('gemini');
  assert.deepEqual(spawned[0].args.slice(0, 3), ['install', '-g', '@google/gemini-cli']);
  assert.throws(() => connect.install('codex'), /Still installing Gemini CLI/);
  await waitFor(() => emitted.some((m) => m.kind === 'done'));
  assert.ok(emitted.some((m) => m.kind === 'out' && /added 1 package/.test(m.text)));
  assert.equal(emitted.find((m) => m.kind === 'done').text, 'Gemini CLI is installed.');
  assert.ok(emitted.some((m) => m.t === 'connect-changed'));
  assert.throws(() => connect.install('rm -rf'), /Unknown agent/);
  assert.throws(() => connect.install('__proto__'), /Unknown agent/);
});

test('a failed install says why, and sign-in needs the CLI to be installed', async () => {
  const { connect, emitted } = connectHarness({ exitCode: 1, installsOnExit: false });
  assert.throws(() => connect.login('gemini'), /not installed yet/);
  connect.install('gemini');
  await waitFor(() => emitted.some((m) => m.kind === 'done'));
  assert.match(emitted.find((m) => m.kind === 'done').text, /npm exited with code 1/);
  const { connect: ok, spawned } = connectHarness({ installed: { codex: { file: '/bin/codex', args: ['x.js'] } } });
  ok.login('codex');
  assert.equal(spawned.at(-1).cmd, 'x-terminal-emulator');
  assert.match(spawned.at(-1).args.at(-1), /'\/bin\/codex' 'x\.js' 'login'/);
});

test('an Antigravity agent streams its reply and tools, maps tool names, and resumes its conversation', async (t) => {
  const w = setup(t);
  w.add({ id: 'agy', name: 'Agy', provider: 'antigravity' });
  await w.action({ t: 'send', agent: 'agy', text: 'Fix the typo' });
  await waitFor(() => !w.snapshot().agy.meta.busy && w.snapshot().agy.events.some((e) => e.k === 'turn'));
  let events = w.snapshot().agy.events;
  const tool = events.find((e) => e.k === 'tool');
  assert.deepEqual([tool.name, tool.cls, tool.status, tool.summary, tool.output], ['Edit', 'edit', 'done', 'a.txt', 'ok']);
  const msgs = events.filter((e) => e.k === 'msg');
  assert.equal(msgs.length, 1, 'the streamed reply is not repeated from the final result');
  assert.ok(msgs[0].text.startsWith('Done: '));
  const first = JSON.parse(msgs[0].text.slice(6));
  assert.deepEqual(first.args.slice(0, 4), ['--output-format', 'stream-json', '--mode', 'plan'], 'a new agent starts read-only');
  assert.ok(!first.args.includes('--conversation') && !first.args.includes('--dangerously-skip-permissions'));
  assert.match(first.text, /Fix the typo/);
  assert.equal(events.find((e) => e.k === 'turn').ok, true);

  await w.action({ t: 'mode', agent: 'agy', mode: 'edit' });
  await w.action({ t: 'send', agent: 'agy', text: 'Again' });
  await waitFor(() => w.snapshot().agy.events.filter((e) => e.k === 'turn').length === 2 && !w.snapshot().agy.meta.busy);
  events = w.snapshot().agy.events;
  const second = JSON.parse(events.filter((e) => e.k === 'msg').at(-1).text.slice(6));
  assert.deepEqual(second.args.slice(second.args.indexOf('--mode'), second.args.indexOf('--mode') + 2), ['--mode', 'accept-edits']);
  assert.ok(!second.args.includes('--settings') && !second.args.includes('--dangerously-skip-permissions'), 'Edit does not let it run commands');
  assert.deepEqual(second.args.slice(second.args.indexOf('--conversation'), second.args.indexOf('--conversation') + 2), ['--conversation', 'agy-conv-1']);
});

test('Antigravity models are read from its list, and it cannot be installed with npm', async () => {
  const { parseAntigravityModels, CLIS } = await import('../server/app/binaries.mjs');
  assert.deepEqual(parseAntigravityModels(['gemini-4-argon-high', 'Gemini 4 Argon (High)'].join(String.fromCharCode(9)) + String.fromCharCode(13, 10) + ['claude-opus-5-5-low', 'Claude Opus 5.5 (Low)'].join(String.fromCharCode(9)) + String.fromCharCode(10, 10)), ['gemini-4-argon-high', 'claude-opus-5-5-low']);
  assert.equal(CLIS.antigravity.pkg, '');
  const connect = createConnect({ specs: {}, clis: CLIS, refresh() {}, emit() {} });
  assert.throws(() => connect.install('antigravity'), /not an npm package/);
});

test('Codex in Edit mode is sandboxed to its folder with the network on; Read-only gets neither', async (t) => {
  const w = setup(t);
  const run = async (mode) => {
    await w.action({ t: 'mode', agent: 'codex', mode });
    await w.action({ t: 'send', agent: 'codex', text: `check ${mode}` });
    await waitFor(() => !w.snapshot().codex.meta.busy && w.snapshot().codex.events.filter((e) => e.k === 'msg').some((e) => e.text.includes(`check ${mode}`)));
    return JSON.parse(w.snapshot().codex.events.filter((e) => e.k === 'msg').at(-1).text).args;
  };
  const edit = await run('edit');
  assert.equal(edit[edit.indexOf('-s') + 1], 'workspace-write');
  assert.ok(edit.includes('sandbox_workspace_write.network_access=true'));
  const read = await run('read');
  assert.equal(read[read.indexOf('-s') + 1], 'read-only');
  assert.ok(!read.includes('sandbox_workspace_write.network_access=true'));
});

test('Antigravity says what it was not allowed to do, instead of an empty reply', async (t) => {
  const w = setup(t);
  w.add({ id: 'agy', name: 'Agy', provider: 'antigravity' });
  await w.action({ t: 'mode', agent: 'agy', mode: 'auto' });
  await w.action({ t: 'send', agent: 'agy', text: 'NEEDS-COMMAND please' });
  await waitFor(() => !w.snapshot().agy.meta.busy && w.snapshot().agy.events.some((e) => e.k === 'turn'));
  const err = w.snapshot().agy.events.find((e) => e.k === 'error');
  assert.match(err.text, /not allowed to run Bash in Auto mode/);
  assert.match(err.text, /Full access/);
});

test('every CLI agent has a Full access mode, and none can use it until it is allowed in Settings', async (t) => {
  const w = setup(t);
  w.add({ id: 'gem', name: 'Gem', provider: 'gemini' });
  w.add({ id: 'agy', name: 'Agy', provider: 'antigravity' });
  for (const id of ['claude', 'codex', 'gem', 'agy']) {
    assert.throws(() => w.action({ t: 'mode', agent: id, mode: 'full' }), /not allowed yet/, id);
    assert.notEqual(w.snapshot()[id].meta.mode, 'full', id);
  }
  w.saveSettings({ agents: { allowFull: true } });
  for (const id of ['claude', 'codex', 'gem', 'agy']) {
    await w.action({ t: 'mode', agent: id, mode: 'full' });
    assert.equal(w.snapshot()[id].meta.mode, 'full', id);
  }
  // Claude is started with permissions bypassed, Antigravity with every prompt skipped.
  await w.action({ t: 'send', agent: 'agy', text: 'go' });
  await waitFor(() => !w.snapshot().agy.meta.busy && w.snapshot().agy.events.some((e) => e.k === 'turn'));
  const args = JSON.parse(w.snapshot().agy.events.filter((e) => e.k === 'msg').at(-1).text.slice(6)).args;
  assert.ok(args.includes('--dangerously-skip-permissions'));
  // Taking the permission back drops every agent out of Full access.
  w.saveSettings({ agents: { allowFull: false } });
  for (const id of ['claude', 'codex', 'gem', 'agy']) assert.notEqual(w.snapshot()[id].meta.mode, 'full', id);
});
