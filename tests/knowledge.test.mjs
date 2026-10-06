import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_AT, bump, knownStack, loadCounts, techFromPath, techFromText } from '../server/learning/knowledge.mjs';
import { createWorkspace } from '../server/workspace.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));

test('technologies are read from messages and from edited file names', () => {
  assert.deepEqual(techFromText('Fix the React component and the CSS, then add Postgres tests'), ['React', 'Postgres', 'Testing', 'CSS']);
  assert.deepEqual(techFromText('nothing technical here'), []);
  assert.deepEqual(techFromPath('src/App.tsx').sort(), ['React', 'TypeScript']);
  assert.deepEqual(techFromPath('C:\\repo\\server\\db.py'), ['Python']);
  assert.deepEqual(techFromPath('Dockerfile'), ['Docker']);
  assert.deepEqual(techFromPath('README.md'), []);
});

test('a technology is known once it has come up often enough, most frequent first', () => {
  const counts = {};
  for (let i = 0; i < KNOWN_AT - 1; i++) assert.equal(bump(counts, ['React']), false);
  assert.deepEqual(knownStack(counts), []);
  assert.equal(bump(counts, ['React', 'Rust']), true); // React crosses the line
  for (let i = 0; i < 5; i++) bump(counts, ['Python']);
  assert.deepEqual(knownStack(counts), [{ name: 'Python', n: 5 }, { name: 'React', n: KNOWN_AT }]);
});

test('old saved profiles keep what they had, and bad saved data is ignored', () => {
  assert.deepEqual(knownStack(loadCounts({ observed: ['Docker', 7, 'SQL'] })).map((k) => k.name), ['Docker', 'SQL']);
  assert.deepEqual(loadCounts({ counts: { React: 4, Evil: 'x', Neg: -1, Zero: 0 } }), { React: 4 });
  assert.deepEqual(loadCounts(null), {});
});

test('the profile picks up a technology from repeated work and uses it in the prompt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-knowledge-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const w = createWorkspace({ root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast() {} });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  const replies = () => w.snapshot().codex.events.filter((e) => e.k === 'msg').map((e) => e.text);
  const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
  const idle = () => !w.snapshot().codex.meta.busy;

  w.setLearningMode(true);
  assert.deepEqual(w.localState().learnerProfile.known, []);
  for (let i = 1; i <= KNOWN_AT; i++) {
    await w.action({ t: 'send', agent: 'codex', text: `Please refactor the React layout, step ${i}` });
    await waitFor(() => replies().length >= i && idle());
  }
  assert.deepEqual(w.localState().learnerProfile.known, [{ name: 'React', n: KNOWN_AT }]);
  await w.action({ t: 'newchat', agent: 'codex' }); // the prompt is sent once per session, so start a fresh one
  await w.action({ t: 'send', agent: 'codex', text: 'Hello' });
  await waitFor(() => replies().length > 0 && idle());
  assert.match(replies().at(-1), new RegExp(`Works with often \\(by how frequently it comes up\\): React \\(${KNOWN_AT}\\)`));
});
