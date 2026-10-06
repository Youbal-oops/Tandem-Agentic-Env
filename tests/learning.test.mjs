import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';
import { detectStack } from '../server/learning/stack.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const idle = (w, id) => !w.snapshot()[id].meta.busy;
const mode = (w, id) => w.snapshot()[id].meta.mode;
const replies = (w, id) => w.snapshot()[id].events.filter((e) => e.k === 'msg').map((e) => e.text);

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-learning-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const w = createWorkspace({ root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast() {} });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  return { w, repo, root };
}

test('stack detection reads the repository, including sub-folders', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-stack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '1', express: '1' }, devDependencies: { typescript: '1', vite: '1' } }));
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM node');
  fs.mkdirSync(path.join(root, 'api'));
  fs.writeFileSync(path.join(root, 'api', 'requirements.txt'), 'Django==5\npytest\n');
  fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'Cargo.toml'), '');
  const stack = detectStack(root);
  for (const label of ['React', 'Express', 'TypeScript', 'Vite', 'Node.js', 'Docker', 'Python', 'Django', 'pytest']) assert.ok(stack.includes(label), label);
  assert.ok(!stack.includes('Rust'));
  assert.ok(!stack.includes('JavaScript'));
  assert.deepEqual(detectStack(path.join(root, 'missing')), []);
});

test('the detected stack reaches the learner profile and the prompt', async (t) => {
  const { w, repo } = setup(t);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { react: '1' } }));
  assert.ok(w.localState().stack.includes('React'));
  w.setLearningMode(true);
  await w.action({ t: 'send', agent: 'codex', text: 'Hi' });
  await waitFor(() => replies(w, 'codex').length > 0);
  assert.match(replies(w, 'codex').join('\n'), /Repo stack \(detected from the repository\): .*React/);
});

test('learning mode is off by default and changes nothing', async (t) => {
  const { w } = setup(t);
  assert.equal(w.localState().learningMode, false);
  await w.action({ t: 'send', agent: 'claude', text: 'Edit freely' });
  await waitFor(() => replies(w, 'claude').length > 0 && idle(w, 'claude'));
  assert.doesNotMatch(replies(w, 'claude').join('\n'), /Working method/);
  w.action({ t: 'mode', agent: 'claude', mode: 'edit' });
  assert.equal(mode(w, 'claude'), 'edit');
});

test('learning mode holds main agents read-only until the user approves, then locks again', async (t) => {
  const { w } = setup(t);
  w.action({ t: 'mode', agent: 'claude', mode: 'edit' });
  w.action({ t: 'mode', agent: 'codex', mode: 'edit' });
  w.setLearningMode(true);
  assert.equal(mode(w, 'claude'), 'plan');
  assert.equal(mode(w, 'codex'), 'read');
  assert.throws(() => w.action({ t: 'mode', agent: 'claude', mode: 'edit' }), /Approve & implement/);
  assert.throws(() => w.action({ t: 'mode', agent: 'codex', mode: 'edit' }), /Approve & implement/);
  assert.equal(mode(w, 'claude'), 'plan');

  assert.throws(() => w.action({ t: 'implement', agent: 'codex' }), /Confirm the design first/);
  assert.equal(mode(w, 'codex'), 'read');
  w.action({ t: 'confirm-design', agent: 'codex' });
  w.action({ t: 'implement', agent: 'codex' });
  assert.equal(mode(w, 'codex'), 'edit');
  await waitFor(() => replies(w, 'codex').some((r) => r.includes('Approved in Tandem')) && idle(w, 'codex'));
  await waitFor(() => mode(w, 'codex') === 'read');
  assert.throws(() => w.action({ t: 'mode', agent: 'codex', mode: 'edit' }), /Approve & implement/);

  w.action({ t: 'implement', agent: 'claude', skipDesign: true }); // a small change: the user skips the design checkpoint
  await waitFor(() => replies(w, 'claude').some((r) => r.includes('acceptEdits') && r.includes('Approved in Tandem') && r.includes('skip the design checkpoint')) && idle(w, 'claude'));
  await waitFor(() => mode(w, 'claude') === 'plan');
});

test('agents cannot delegate in learning mode until approved; turning it off releases the lock', async (t) => {
  const { w } = setup(t);
  w.setLearningMode(true);
  assert.throws(() => w.childAction({ t: 'child-create', agent: 'claude', provider: 'codex', text: 'Do it', viaAgent: true }), /Approve & implement/);
  // The user starting a child task from the UI is not blocked.
  w.childAction({ t: 'child-create', agent: 'claude', provider: 'codex', text: 'Do it' });
  await waitFor(() => w.children().length === 1);
  w.setLearningMode(false);
  w.action({ t: 'mode', agent: 'claude', mode: 'edit' });
  assert.equal(mode(w, 'claude'), 'edit');
  w.childAction({ t: 'child-create', agent: 'claude', provider: 'codex', text: 'Again', viaAgent: true });
});
