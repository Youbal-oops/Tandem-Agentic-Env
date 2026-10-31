import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';
import { STARTERS } from './fixtures/starters.mjs';
import { appendLearning, contextPrompt, parseTeaching, readDocs, section, updateContext } from '../server/learning/docs.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-ping-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const w = createWorkspace({ initialAgents: STARTERS, root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast() {} });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  return { w, root, repo };
}

test('an idle main agent is told when a subagent finishes, with a line in its chat', async (t) => {
  const { w } = setup(t);
  w.childAction({ t: 'child-create', agent: 'codex', provider: 'claude', text: 'Review settings' });
  await waitFor(() => w.snapshot().codex.events.some((e) => e.k === 'user' && /^\[Tandem: subagent update\]/.test(e.text)));
  const events = w.snapshot().codex.events;
  assert.ok(events.some((e) => e.k === 'note' && /Claude subagent "Review settings" finished/.test(e.text)));
  const ping = events.find((e) => e.k === 'user');
  assert.match(ping.text, /Its full chat is attached to this conversation/);
});

test('with the ping switched off the main chat only gets the completion line', async (t) => {
  const { w } = setup(t);
  w.saveSettings({ agents: { pingMain: false } });
  w.childAction({ t: 'child-create', agent: 'codex', provider: 'claude', text: 'Review settings' });
  await waitFor(() => w.snapshot().codex.events.some((e) => e.k === 'note'));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(w.snapshot().codex.events.map((e) => e.k), ['note']);
});

test('a busy main agent gets the line but no second turn', async (t) => {
  const { w } = setup(t);
  await w.action({ t: 'send', agent: 'codex', text: 'SLOW-TURN hold on' });
  assert.equal(w.snapshot().codex.meta.busy, true);
  w.childAction({ t: 'child-create', agent: 'codex', provider: 'claude', text: 'Review settings' });
  await waitFor(() => !w.children()[0].meta.busy);
  await waitFor(() => !w.snapshot().codex.meta.busy);
  await new Promise((r) => setTimeout(r, 300));
  const users = w.snapshot().codex.events.filter((e) => e.k === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].text.includes('subagent update'), false);
});

test('learning documents: notes are filed, teaching context accumulates and is shared as prompt text', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-docs-'));
  const report = 'Done.\n\n## Learning note\nWhat was made: a login form.\nHow it works: form -> handler.\n\n## Teaching notes\n- Pattern: a small diagram helped\n- Progress: understood props\n- Next: state and effects\n';
  assert.match(section(report, 'Learning note'), /a login form/);
  assert.doesNotMatch(section(report, 'Learning note'), /Teaching notes/);
  const teaching = parseTeaching(report);
  assert.deepEqual(teaching, { pattern: ['a small diagram helped'], progress: ['understood props'], next: ['state and effects'] });

  assert.equal(appendLearning(repo, { title: 'Add login', request: 'Add login', files: ['src/Login.jsx'], report, note: section(report, 'Learning note'), level: 'new' }), true);
  updateContext(repo, teaching, { level: 'new', style: 'diagrams', familiar: 'HTML', learning: 'React', known: [{ name: 'React', n: 3 }] });
  updateContext(repo, { pattern: ['a small diagram helped', 'analogies did not land'], progress: [], next: ['routing'] }, { level: 'new' });

  const docs = readDocs(repo);
  assert.match(docs.learning, /Add login/);
  assert.match(docs.learning, /What was made: a login form/);
  assert.match(docs.learning, /Level: new/);
  assert.match(docs.context, /Experience: new/);
  assert.equal((docs.context.match(/a small diagram helped/g) || []).length, 1, 'deduplicated');
  assert.match(docs.context, /analogies did not land/);
  assert.match(docs.context, /understood props/, 'earlier progress is kept');
  assert.match(docs.context, /## Next to teach\n- routing/, 'next is replaced, not accumulated');
  assert.match(contextPrompt(repo), /Learning context/);
  assert.equal(contextPrompt(fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-docs-'))), '');
  assert.equal(appendLearning(repo, { title: 'Empty', report: '', note: '' }), false);
});
