// Launch the actual Windows executable with isolated data and verify its renderer
// and embedded server. No real agent requests or user account changes are made.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';

let executable = path.resolve(process.argv[2] || 'release/win-unpacked/Tandem.exe');
assert.ok(fs.existsSync(executable), `Executable missing: ${executable}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-package-check-'));
if (/^Tandem-Setup-.*\.exe$/i.test(path.basename(executable))) {
  // Test the installer payload without changing the user's installed copy,
  // uninstall registration or shortcuts.
  const destination = path.join(root, 'installer');
  const sevenZip = path.resolve('node_modules/7zip-bin/win/x64/7za.exe');
  const extracted = spawnSync(sevenZip, ['x', executable, `-o${destination}`, '-y'], { encoding: 'utf8', windowsHide: true });
  assert.ok(extracted.status === 0 || extracted.status === 1, extracted.stderr || extracted.error?.message);
  executable = path.join(destination, 'Tandem.exe');
  assert.ok(fs.existsSync(executable), 'Installer payload is missing Tandem.exe');
}
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const port = await freePort(), debugPort = await freePort();
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, TANDEM_PORT: String(port), TANDEM_CWD: workspace, TANDEM_DATA_ROOT: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ['--tandem-smoke-test', `--remote-debugging-port=${debugPort}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', spawnError;
child.on('error', (error) => { spawnError = error; });
child.stdout.on('data', (data) => { output += data; });
child.stderr.on('data', (data) => { output += data; });
const sockets = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`App exited with ${child.exitCode}: ${output}`);
    try { const result = await check(); if (result) return result; } catch {}
    await delay(250);
  }
  throw new Error(`Timed out: ${label}\n${output}`);
}
async function connect(url, options = {}) {
  const ws = new WebSocket(url, options); sockets.push(ws);
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}
try {
  const session = await eventually(async () => {
    const res = await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(2000) });
    return res.ok && await res.json();
  }, 'packaged server startup');
  assert.equal(session.local.cwd, workspace);
  assert.equal(session.agents.length, 2);
  assert.ok(fs.existsSync(path.join(workspace, '.tandem', 'PROJECT_CONTEXT.md')));
  console.log('PASS packaged server, agents, isolated data and shared project context');
  const html = await (await fetch(origin)).text();
  assert.match(html, /id="setup-dialog"/);
  for (const [, asset] of html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)) {
    const res = await fetch(origin + asset);
    assert.equal(res.status, 200, asset);
    assert.doesNotMatch(res.headers.get('content-type') || '', /text\/html/, asset);
    if (asset.endsWith('.css')) {
      for (const [, font] of (await res.text()).matchAll(/url\(["']?([^\s)"']+\.woff2?)["']?\)/g)) {
        const resource = await fetch(new URL(font, origin + asset));
        assert.equal(resource.status, 200, font);
        assert.doesNotMatch(resource.headers.get('content-type') || '', /text\/html/, font);
      }
    }
  }
  for (const model of ['cat.glb', 'kitten.glb', 'tandem_cat.glb']) {
    const res = await fetch(`${origin}/models/${model}`);
    assert.equal(res.status, 200, model);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), 'glTF', model);
  }
  console.log('PASS bundled HTML, JavaScript, styles and fonts');
  const targets = await eventually(async () => {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const pages = await res.json(); return pages.find((page) => page.type === 'page' && page.url.startsWith(origin));
  }, 'desktop window');
  const cdp = await connect(targets.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map(), errors = [];
  cdp.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    const callback = pending.get(msg.id); if (callback) { pending.delete(msg.id); callback(msg); }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, (msg) => { clearTimeout(timer); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); });
    cdp.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const value = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!value.exceptionDetails, value.exceptionDetails?.text); return value.result.value;
  };
  await command('Runtime.enable');
  // Reload after enabling exception capture so startup errors cannot slip past.
  await command('Page.enable'); await command('Page.reload');
  await eventually(() => evaluate(`document.querySelector('#setup-dialog')?.open && document.querySelectorAll('.agent[data-agent]').length >= 2`), 'renderer initialization', 30000);
  const safety = await evaluate(`({ require: typeof require, process: typeof process })`);
  assert.deepEqual(safety, { require: 'undefined', process: 'undefined' });
  await evaluate(`document.querySelector('#finish-setup').click(); true`);
  assert.equal(await evaluate(`document.querySelector('#setup-dialog').open`), false);
  assert.equal(await evaluate(`localStorage.getItem('tandem:setup-complete')`), '1');
  assert.deepEqual(errors, [], `Renderer errors: ${errors.join('\n')}`);
  console.log('PASS real renderer startup, onboarding and browser isolation');
  const agent = session.agents[0];
  const panel = `document.querySelector(${JSON.stringify(`#chat-${agent.id}`)})`;
  await evaluate(`{
    const textarea = ${panel}.querySelector('textarea');
    textarea.value = 'Keep this draft in the original chat';
    textarea.dispatchEvent(new Event('input'));
    ${panel}.querySelector('.c-new').click();
  }`);
  await eventually(async () => {
    const data = await (await fetch(`${origin}/api/session`)).json();
    return data.agents.find((row) => row.id === agent.id)?.conversationId !== agent.conversationId;
  }, 'new chat creation');
  await eventually(() => evaluate(`${panel}.querySelector('textarea').value === ''`), 'fresh conversation draft');
  await evaluate(`${panel}.querySelector('.c-history').click()`);
  await eventually(() => evaluate(`document.querySelectorAll('#history-dialog .history-entry').length === 2`), 'history picker');
  await evaluate(`document.querySelector('#history-dialog .history-entry:not(:disabled)').click()`);
  await eventually(() => evaluate(`!document.querySelector('#history-dialog').open && ${panel}.querySelector('textarea').value === 'Keep this draft in the original chat'`), 'reopened conversation and preserved draft');
  const reopened = await (await fetch(`${origin}/api/session`)).json();
  assert.equal(reopened.agents.find((row) => row.id === agent.id).conversationId, agent.conversationId);
  console.log('PASS new chat, history picker, conversation restore and isolated drafts');
  const ws = await connect(`ws://127.0.0.1:${port}/ws?token=${session.token}`, { origin });
  const saved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Notes save timed out')), 10000);
    ws.on('message', (raw) => { const msg = JSON.parse(raw); if (msg.t === 'localstate' && msg.saved) { clearTimeout(timer); resolve(msg); } });
  });
  ws.send(JSON.stringify({ t: 'savenotes', cwd: workspace, text: 'Packaged smoke check' }));
  assert.equal((await saved).notes, 'Packaged smoke check');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'data', '.tandem', 'workspace.json')));
  assert.equal(state.notes[workspace], 'Packaged smoke check');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  const upload = await fetch(`${origin}/api/images`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` }, body: png });
  assert.equal(upload.status, 201);
  const image = await upload.json();
  const preview = await fetch(origin + image.url);
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${origin}/api/images`, { method: 'POST', body: png })).status, 403);
  console.log('PASS WebSocket, saved settings, image upload/preview and authorization');
  console.log(`Desktop package check passed: ${executable}`);
} finally {
  for (const ws of sockets) ws.close();
  if (child.pid && child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill();
  }
  // Retain logs and isolated test data for inspection; never delete user data.
  fs.writeFileSync(path.join(root, 'desktop.log'), output);
  console.log(`Check logs: ${root}`);
}
