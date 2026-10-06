import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';
import { workflowPrompt } from '../server/learning/workflow.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const echoed = (events) => events.filter((e) => e.k === 'msg').map((e) => e.text).join('\n');

test('working method depends on the provider and the checkpoint pace', () => {
  assert.match(workflowPrompt('claude'), /AskUserQuestion/);
  assert.match(workflowPrompt('codex'), /numbered list/);
  assert.doesNotMatch(workflowPrompt('codex'), /AskUserQuestion/);
  assert.match(workflowPrompt('claude', 'light'), /large, ambiguous or risky/);
  assert.match(workflowPrompt('claude', 'frequent'), /every step/);
});

test('in learning mode main agents get the working method and learner profile, subagent chats do not', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-workflow-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const w = createWorkspace({ root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast() {} });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });

  w.setLearningMode(true);
  await w.action({ t: 'send', agent: 'claude', text: 'Plan a feature' });
  await w.action({ t: 'send', agent: 'codex', text: 'Plan a feature' });
  await waitFor(() => w.snapshot().claude.events.some((e) => e.k === 'msg') && w.snapshot().codex.events.some((e) => e.k === 'msg'));
  const claude = echoed(w.snapshot().claude.events), codex = echoed(w.snapshot().codex.events);
  assert.match(claude, /Working method: build together/);
  assert.match(claude, /AskUserQuestion/);
  assert.match(claude, /Learner profile/);
  assert.match(codex, /Working method: build together/);
  assert.match(codex, /numbered list/);
  assert.doesNotMatch(codex, /AskUserQuestion/);

  w.childAction({ t: 'child-create', agent: 'claude', provider: 'codex', text: 'Do the small task' });
  await waitFor(() => w.children()[0]?.events.some((e) => e.k === 'msg'));
  const child = echoed(w.children()[0].events);
  assert.match(child, /Do the small task/);
  assert.doesNotMatch(child, /Working method|Learner profile/);
});
