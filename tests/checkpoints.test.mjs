import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginImplement, finishImplement, freshCheckpoint, isConfirm, isDesignCard, noteFile, onDesignConfirmed, onDesignProposed, onUserMessage, publicView } from '../server/learning/checkpoints.mjs';
import { appendEntry, clearJournal, entryToMarkdown, journalPrompt, parseJournal, readEntries } from '../server/learning/journal.mjs';
import { workflowPrompt } from '../server/learning/workflow.mjs';
import { createWorkspace } from '../server/workspace.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const tmp = (t, name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })); return d; };

test('a step moves build -> design -> implement -> report, and the next message starts a new cycle', () => {
  const cp = freshCheckpoint();
  onUserMessage(cp, '  Add a retry   to the\npush button ');
  assert.equal(cp.request, 'Add a retry to the push button');
  assert.deepEqual(publicView(cp), { stage: 'build', designConfirmed: false, skipped: false });
  onUserMessage(cp, 'more thoughts');
  assert.equal(cp.request, 'Add a retry to the push button', 'only the first message names the step');

  onDesignProposed(cp, 'Retry three times with backoff');
  assert.equal(cp.stage, 'design');
  assert.equal(cp.designConfirmed, false);
  assert.throws(() => beginImplement(cp), /Confirm the design first/);

  onDesignConfirmed(cp, { choices: ['Backoff: exponential'] });
  assert.equal(cp.designConfirmed, true);
  beginImplement(cp);
  assert.equal(cp.stage, 'implement');
  assert.equal(cp.skipped, false);
  noteFile(cp, 'src/push.js'); noteFile(cp, 'src/push.js'); noteFile(cp, 'tests/push.test.mjs');
  assert.deepEqual(cp.files, ['src/push.js', 'tests/push.test.mjs']);

  onDesignProposed(cp, 'ignored while implementing');
  assert.equal(cp.stage, 'implement');
  finishImplement(cp);
  assert.equal(cp.stage, 'report');
  noteFile(cp, 'late.js');
  assert.equal(cp.files.length, 2, 'files are only noted while implementing');

  onUserMessage(cp, 'Now do the terminal');
  assert.deepEqual(publicView(cp), { stage: 'build', designConfirmed: false, skipped: false });
  assert.equal(cp.request, 'Now do the terminal');
});

test('skipping the design checkpoint is explicit and remembered', () => {
  const cp = freshCheckpoint();
  beginImplement(cp, { skipDesign: true });
  assert.equal(cp.stage, 'implement');
  assert.equal(cp.skipped, true);
});

test('selection cards: Confirm is recognised, and only a card offering it is a design checkpoint', () => {
  assert.ok(isConfirm('Confirm and continue'));
  assert.ok(isConfirm('confirm'));
  assert.ok(!isConfirm('Discuss'));
  assert.ok(!isConfirm('Do not confirm'));
  const card = [{ question: 'Use a queue?', options: [{ label: 'Confirm and continue' }, { label: 'Discuss' }] }];
  assert.ok(isDesignCard(card));
  assert.ok(!isDesignCard([{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }]));
  assert.ok(!isDesignCard(undefined));
});

test('the journal is readable Markdown that survives edits, and feeds the next session', (t) => {
  const repo = tmp(t, 'tandem-journal-');
  assert.deepEqual(readEntries(repo), []);
  assert.equal(journalPrompt(repo), '');
  appendEntry(repo, { at: Date.parse('2026-10-05T14:32:00Z'), title: 'Add retry', request: 'Add retry to push', design: 'Retry 3 times', choices: ['Backoff: exponential'], files: ['src/push.js'], report: 'Added retry.\nChecked by hand.' });
  appendEntry(repo, { at: Date.parse('2026-10-06T09:00:00Z'), title: 'Skip case', request: 'Fix typo', skipped: true, files: [], report: 'Fixed.' });
  const text = fs.readFileSync(path.join(repo, '.tandem', 'LEARNING.md'), 'utf8');
  assert.match(text, /^# Learning journal/);
  assert.match(text, /## 2026-10-05 14:32 · Add retry/);
  assert.match(text, /- Design: skipped \(small change\)/);
  assert.doesNotMatch(text, /Added retry\.\nChecked/, 'every field stays on one line');

  const entries = readEntries(repo);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].fields.files, 'src/push.js');
  assert.equal(entries[0].fields.report, 'Added retry. Checked by hand.');
  assert.equal(entries[1].fields.design, 'skipped (small change)');

  const prompt = journalPrompt(repo);
  assert.match(prompt, /Learning journal/);
  assert.match(prompt, /Add retry/);
  assert.ok(prompt.indexOf('Add retry') < prompt.indexOf('Skip case'), 'newest last');
  assert.ok(parseJournal(entryToMarkdown({ at: 0, request: 'x' })).length === 1);

  clearJournal(repo);
  assert.deepEqual(readEntries(repo), []);
});

test('teaching adapts to the learner: level and style change the working method', () => {
  assert.match(workflowPrompt('claude', 'normal', { level: 'new', style: 'diagrams' }), /new to this[^]*text diagrams/);
  assert.match(workflowPrompt('claude', 'normal', { level: 'confident' }), /experienced/);
  assert.match(workflowPrompt('codex', 'normal', { level: 'familiar', style: 'questions' }), /guiding questions/);
  assert.match(workflowPrompt('codex'), /Everyone reasons first/);
});

test('the full cycle in a workspace: confirm, implement, lock again, journal, and the journal reaches the next chat', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-cycle-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const seen = [];
  const w = createWorkspace({ root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast: (m) => { if (m.t === 'checkpoint') seen.push(`${m.agent}:${m.checkpoint.stage}${m.checkpoint.designConfirmed ? '+' : ''}`); } });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  const replies = (id) => w.snapshot()[id].events.filter((e) => e.k === 'msg').map((e) => e.text);
  const idle = (id) => !w.snapshot()[id].meta.busy;

  w.setLearningMode(true);
  assert.deepEqual(w.localState().checkpoints, { claude: { stage: 'build', designConfirmed: false, skipped: false }, codex: { stage: 'build', designConfirmed: false, skipped: false } });

  await w.action({ t: 'send', agent: 'codex', text: 'Add a retry to the push button' });
  await waitFor(() => replies('codex').length > 0 && idle('codex'));
  w.action({ t: 'confirm-design', agent: 'codex' });
  assert.equal(w.localState().checkpoints.codex.designConfirmed, true);

  w.action({ t: 'implement', agent: 'codex' });
  assert.equal(w.localState().checkpoints.codex.stage, 'implement');
  await waitFor(() => w.localState().checkpoints.codex.stage === 'report');
  assert.ok(seen.includes('codex:implement+') && seen.includes('codex:report+'), seen.join(' '));

  const journal = w.journal();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].title, 'Add a retry to the push button');
  assert.match(journal[0].fields.report, /Approved in Tandem/); // the fixture CLI echoes its prompt as its "report"

  await w.action({ t: 'newchat', agent: 'claude' });
  await w.action({ t: 'send', agent: 'claude', text: 'Hello again' });
  await waitFor(() => replies('claude').length > 0);
  assert.match(replies('claude').join('\n'), /Learning journal[^]*Add a retry to the push button/);

  assert.deepEqual(w.clearJournal(), []);
  await w.action({ t: 'send', agent: 'codex', text: 'Next thing' });
  assert.equal(w.localState().checkpoints.codex.stage, 'build', 'a new message after a report starts a new cycle');
});
