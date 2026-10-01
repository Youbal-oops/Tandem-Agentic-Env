import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';
import { pluginStateDirs } from '../server/children.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('Child fixture timed out'); await new Promise((r) => setTimeout(r, 20)); } };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-children-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const pluginRoot = path.join(root, 'plugin');
  const events = [];
  const options = { root, cwd: repo, specs, pluginRoots: [pluginRoot], childPollMs: 60000, broadcast: (m) => events.push(m) };
  const w = createWorkspace(options);
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  return { w, root, repo, pluginRoot, events, options };
}

test('child tasks stream independently, resume, and preserve their parent after restart', async (t) => {
  const { w, options, events } = setup(t);
  const c = w.childAction({ t: 'child-create', agent: 'codex', provider: 'claude', text: 'Review settings' });
  await waitFor(() => !w.children()[0].meta.busy);
  assert.equal(w.snapshot().codex.events.length, 0);
  assert.equal(w.children()[0].parentId, 'codex');
  assert.ok(events.some((m) => m.t === 'child-event' && m.ev.k === 'msg'));
  assert.equal(w.children()[0].meta.mode, 'plan');
  w.childAction({ id: c.id, action: 'send', text: 'Check the fallback too' });
  await waitFor(() => w.children()[0].meta.turns === 2);
  assert.equal(w.children()[0].events.filter((e) => e.k === 'user').length, 2);
  w.closeAll();
  const restored = createWorkspace(options);
  t.after(() => restored.closeAll());
  assert.equal(restored.children().length, 1);
  assert.equal(restored.children()[0].id, c.id);
  restored.childAction({ id: c.id, action: 'send', text: 'Continue after restart' });
  await waitFor(() => restored.children()[0].meta.turns === 3);
  const reply = JSON.parse(restored.children()[0].events.filter((e) => e.k === 'msg').at(-1).text);
  assert.ok(reply.args.includes('--resume'));
  assert.equal(reply.text, 'Continue after restart');
  restored.closeAll();
});

test('new main conversation and repo switches isolate child histories', async (t) => {
  const { w, root } = setup(t);
  const c = w.childAction({ t: 'child-create', agent: 'claude', provider: 'codex', text: 'First task' });
  assert.throws(() => w.action({ t: 'newchat', agent: 'claude' }), /child tasks/);
  assert.throws(() => w.switchRepo(root), /Stop all/);
  await waitFor(() => !w.children()[0].meta.busy);
  w.action({ t: 'newchat', agent: 'claude' });
  assert.equal(w.children().length, 0);
  assert.throws(() => w.childAction({ id: c.id, action: 'send', text: 'Wrong conversation' }), /different conversation/);
  const next = w.childAction({ t: 'child-create', agent: 'codex', provider: 'claude', text: 'Next task' });
  await waitFor(() => !w.children()[0].meta.busy);
  w.switchRepo(root); assert.equal(w.children().length, 0);
  assert.throws(() => w.childAction({ id: next.id, action: 'send', text: 'Wrong repo' }), /different conversation/);
});

test('plugin jobs attach only to the originating session, update without duplicates, and can be resumed', async (t) => {
  const { w, repo, pluginRoot } = setup(t);
  w.action({ t: 'send', agent: 'claude', text: 'Main task' });
  await waitFor(() => w.snapshot().claude.meta.turns === 1);
  const dir = pluginStateDirs(repo, [pluginRoot])[0]; fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  const job = { id: 'task-123', sessionId: '00000000-0000-4000-8000-000000000002', threadId: '00000000-0000-4000-8000-000000000001', status: 'running', pid: process.pid, summary: 'Review auth', jobClass: 'task' };
  const write = (extra = {}) => {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ jobs: [job, { ...job, id: 'unrelated', sessionId: 'some-other-session' }] }));
    fs.writeFileSync(path.join(dir, 'jobs', 'task-123.json'), JSON.stringify({ ...job, ...extra }));
  };
  write(); fs.writeFileSync(path.join(dir, 'jobs', 'task-123.log'), 'Read auth.js\nAssistant message\nChecking token expiry.');
  w.pollChildren(); assert.equal(w.children().length, 1);
  const c = w.children()[0]; assert.equal(c.parentId, 'claude'); assert.equal(c.meta.external, true);
  assert.match(c.events.find((e) => e.k === 'tool').output, /token expiry/);
  assert.throws(() => w.childAction({ id: c.id, action: 'send', text: 'Race' }), /still running/);
  job.status = 'completed'; write({ result: { rawOutput: 'Token expiry is checked.' } });
  w.pollChildren(); w.pollChildren();
  assert.equal(w.children().length, 1);
  assert.equal(w.children()[0].events.filter((e) => e.k === 'msg').length, 1);
  assert.equal(w.children()[0].meta.external, false);
  w.childAction({ id: c.id, action: 'send', text: 'Check refresh tokens' });
  await waitFor(() => !w.children()[0].meta.busy);
  const reply = JSON.parse(w.children()[0].events.filter((e) => e.k === 'msg').at(-1).text);
  assert.ok(reply.args.includes(job.threadId)); assert.ok(reply.args.includes('resume'));
});

test('invalid child requests and traversal-shaped plugin IDs are rejected', (t) => {
  const { w } = setup(t);
  assert.throws(() => w.childAction({ t: 'child-create', agent: 'missing', provider: 'claude', text: 'Task' }), /main chat/);
  assert.throws(() => w.childAction({ t: 'child-create', agent: 'codex', provider: 'shell', text: 'Task' }), /CLI/);
  assert.throws(() => w.childAction({ t: 'child-create', agent: 'codex', provider: 'claude', text: '' }), /task/);
  assert.throws(() => w.childAction({ t: 'child-create', agent: 'codex', provider: 'claude', text: 'Task', model: '../bad model' }), /model/);
});
