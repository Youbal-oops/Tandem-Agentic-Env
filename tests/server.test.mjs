import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const APP = fileURLToPath(new URL('..', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** Start the real server on a spare port with its data and repository in a temp folder, and connect to it. */
async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-server-'));
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't'); git(repo, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed');

  const port = await freePort();
  const proc = spawn(process.execPath, ['server/index.mjs'], { cwd: APP, stdio: 'ignore', windowsHide: true, env: { ...process.env, TANDEM_PORT: String(port), TANDEM_APP_ROOT: APP, TANDEM_DATA_ROOT: path.join(root, 'data'), TANDEM_CWD: repo } });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { proc.kill(); await new Promise((r) => setTimeout(r, 300)); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); });

  let session;
  for (let i = 0; i < 100 && !session; i++) { try { session = await (await fetch(`${base}/api/session`)).json(); } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.ok(session?.token, 'server did not start');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.token}`, { headers: { Origin: base } });
  const log = [];
  ws.on('message', (d) => log.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  t.after(() => ws.close());
  const send = (m) => ws.send(JSON.stringify(m));
  const wait = async (pred, ms = 20000) => { const end = Date.now() + ms; while (true) { const hit = log.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error('timeout; saw ' + JSON.stringify(log.map((m) => m.t))); await new Promise((r) => setTimeout(r, 30)); } };
  return { base, port, session, ws, send, wait, log, repo, remote, root };
}

test('the session handshake and the UI shell come from the real server', async (t) => {
  const { base, session } = await boot(t);
  assert.deepEqual(Object.keys(session.modes).sort(), ['claude', 'codex']);
  assert.equal(session.local.learningMode, false);
  assert.deepEqual(session.local.checkpoints, { claude: { stage: 'build', designConfirmed: false, skipped: false }, codex: { stage: 'build', designConfirmed: false, skipped: false } });
  const status = (host) => new Promise((resolve, reject) => http.get(`${base}/`, { headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(await status('evil.example'), 403, 'a wrong Host header is refused (DNS rebinding)');
  assert.equal(await status(new URL(base).host), 200);
  const bad = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws?token=nope`, { headers: { Origin: base } });
  await new Promise((resolve) => { bad.on('error', resolve); bad.on('unexpected-response', resolve); });
});

test('learning mode, the checkpoint stage and the journal travel over the socket', async (t) => {
  const { send, wait, log } = await boot(t);
  assert.equal((await wait((m) => m.t === 'snapshot')).configs.length, 2);
  send({ t: 'learningmode', on: true });
  const lp = await wait((m) => m.t === 'learnerprofile' && m.learningMode === true);
  assert.equal(lp.learnerProfile.level, 'familiar');
  send({ t: 'confirm-design', agent: 'codex' });
  assert.deepEqual((await wait((m) => m.t === 'checkpoint' && m.agent === 'codex' && m.checkpoint.designConfirmed)).checkpoint, { stage: 'design', designConfirmed: true, skipped: false });
  send({ t: 'implement', agent: 'claude' }); // not confirmed, so the server refuses
  assert.match((await wait((m) => m.t === 'notice' && /Confirm the design first/.test(m.text))).text, /skip the design checkpoint/);
  send({ t: 'journal' });
  assert.deepEqual((await wait((m) => m.t === 'journal')).entries, []);
  assert.ok(!log.some((m) => m.t === 'checkpoint' && m.agent === 'claude' && m.checkpoint.stage === 'implement'));
});

test('push dialog and terminal work through the real server', async (t) => {
  const { send, wait, log, remote } = await boot(t);
  send({ t: 'pushinfo', source: 'repo' });
  const info = await wait((m) => m.t === 'pushinfo');
  assert.equal(info.branch, 'tandem/repo');
  assert.ok(info.files.some((f) => f.path === 'a.txt'));
  assert.deepEqual(info.dirs.map((d) => d.id), ['repo', 'claude', 'codex']);

  send({ t: 'push', source: 'repo', branch: 'main', message: 'x', files: [] });
  assert.match((await wait((m) => m.t === 'push-done')).error, /must start with tandem\//);
  log.length = 0;
  send({ t: 'push', source: 'repo', branch: 'tandem/repo-ui', message: 'Change a', files: ['a.txt'] });
  assert.equal((await wait((m) => m.t === 'push-done')).ok, true);
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'tandem/repo-ui'), 'Change a');

  log.length = 0;
  send({ t: 'term-open', source: 'repo' });
  await wait((m) => m.t === 'term' && m.kind === 'ready');
  send({ t: 'term-run', line: 'git log -1 --format=%s' });
  await wait((m) => m.t === 'term' && m.kind === 'done');
  assert.match(log.filter((m) => m.kind === 'out').map((m) => m.text).join(''), /Change a/);
});
