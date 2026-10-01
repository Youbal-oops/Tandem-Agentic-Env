import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('Fixture timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const lastReply = (w, agent) => JSON.parse(w.snapshot()[agent].events.filter((e) => e.k === 'msg').at(-1).text).text;
const text = (m) => (typeof m === 'string' ? m : JSON.stringify(m));

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-prompt-'));
  const repoA = path.join(root, 'alpha'); const repoB = path.join(root, 'beta');
  fs.mkdirSync(repoA); fs.mkdirSync(repoB);
  const w = createWorkspace({ root, cwd: repoA, specs, childPollMs: 60000, broadcast() {} });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  return { w, root, repoA, repoB };
}
async function ask(w, agent, msg) {
  const turns = w.snapshot()[agent].meta.turns;
  w.action({ t: 'send', agent, text: msg });
  await waitFor(() => w.snapshot()[agent].meta.turns > turns);
  return text(lastReply(w, agent));
}

test('the global prompt reaches every agent once per session and refreshes on edit, new chat and repo switch', async (t) => {
  const { w, repoB } = setup(t);
  w.savePrompt('Check my site for {{repo}} as {{agent}}.', true);
  const first = await ask(w, 'claude', 'one');
  assert.match(first, /Check my site for alpha as Claude\./);
  assert.match(first, /\[Task\]\none$/);
  assert.doesNotMatch(await ask(w, 'claude', 'two'), /Check my site/);
  w.savePrompt('Use the notes for {{path}}.', true);
  assert.match(await ask(w, 'claude', 'three'), /Use the notes for .*alpha\./);
  assert.match(await ask(w, 'codex', 'hello'), /Check my site|Use the notes/);
  w.action({ t: 'newchat', agent: 'claude' });
  assert.match(await ask(w, 'claude', 'fresh'), /Use the notes for/);
  w.savePrompt('Check my site for {{repo}}.', true);
  w.switchRepo(repoB);
  assert.match(await ask(w, 'codex', 'after switch'), /Check my site for beta\./);
  assert.match(await ask(w, 'claude', 'after switch'), /Check my site for beta\./);
});

test('a disabled or empty prompt adds nothing, and the prompt persists and is validated', async (t) => {
  const { w, root, repoA } = setup(t);
  w.savePrompt('Secret standing order', false);
  assert.doesNotMatch(await ask(w, 'claude', 'plain'), /Secret standing order/);
  assert.throws(() => w.savePrompt('x'.repeat(8001), true), /8,000/);
  assert.throws(() => w.savePrompt(5, true), /8,000/);
  assert.deepEqual(w.localState().prompt, { text: 'Secret standing order', on: false });
  w.closeAll();
  const again = createWorkspace({ root, cwd: repoA, specs, childPollMs: 60000, broadcast() {} });
  t.after(() => again.closeAll());
  assert.deepEqual(again.localState().prompt, { text: 'Secret standing order', on: false });
});

test('subagent chats receive the global prompt too', async (t) => {
  const { w } = setup(t);
  w.savePrompt('Standing order for {{agent}} in {{repo}}.', true);
  w.childAction({ t: 'child-create', agent: 'codex', provider: 'claude', text: 'child task' });
  await waitFor(() => w.children()[0] && !w.children()[0].meta.busy && w.children()[0].events.some((e) => e.k === 'msg'));
  assert.match(text(JSON.parse(w.children()[0].events.find((e) => e.k === 'msg').text).text), /Standing order for Claude in alpha\./);
});
