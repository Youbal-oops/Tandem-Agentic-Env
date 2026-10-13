import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { countEdit, createReview, cutoffOf, overLimit, PROPOSAL_ROOM } from '../server/review/review.mjs';
import { numstat, patch, snapshotTree } from '../server/review/tree.mjs';
import { cleanReview, createSettings, REVIEW_DEFAULTS } from '../server/settings.mjs';

const limits = { enabled: true, maxLines: 10, maxFiles: 2 };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-review-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('countEdit measures each edit tool from its input', () => {
  assert.deepEqual(countEdit('Edit', { file_path: 'a.js', old_string: 'a\nb', new_string: 'x\ny\nz' }).added, 3);
  assert.equal(countEdit('Edit', { file_path: 'a.js', old_string: 'a\nb', new_string: 'x' }).removed, 2);
  assert.equal(countEdit('Write', { file_path: 'b.js', content: '1\n2\n3\n4' }).added, 4);
  assert.equal(countEdit('MultiEdit', { file_path: 'c.js', edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd', new_string: 'e' }] }).added, 3);
  assert.equal(countEdit('Bash', { command: 'ls' }), null);
});

test('overLimit counts lines and files, and honours the room given for a proposal', () => {
  assert.equal(overLimit({ lines: 5, files: 1 }, limits), null);
  assert.match(overLimit({ lines: 11, files: 1 }, limits), /11 changed lines is over the limit of 10/);
  assert.match(overLimit({ lines: 5, files: 3 }, limits), /3 files/);
  assert.match(overLimit({ lines: 8, files: 1 }, limits, 5), /13 changed lines/);
  assert.equal(overLimit({ lines: 11, files: 1 }, limits, 0, 11 + PROPOSAL_ROOM), null);
  assert.equal(overLimit({ lines: 9999, files: 99 }, { ...limits, enabled: false }), null);
});

test('settings are validated and only the review section is replaced', () => {
  assert.deepEqual(cleanReview({ enabled: false, maxLines: 2, maxFiles: 'x' }), { ...REVIEW_DEFAULTS, enabled: false });
  assert.equal(cleanReview({ maxLines: 5000 }).maxLines, 5000);
  const s = createSettings({ saved: { settings: { review: { maxLines: 50 } } } });
  assert.equal(s.review().maxLines, 50);
  assert.equal(s.save({ review: { maxFiles: 4 } }).review.maxLines, 50);
  assert.throws(() => s.save(null));
});

test('a tree snapshot gives per-file counts and a patch without touching the real index', async () => {
  const dir = repo();
  const before = await snapshotTree(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x\ny\n');
  const after = await snapshotTree(dir);
  const list = await numstat(dir, before, after);
  assert.deepEqual(list.map((f) => [f.path, f.added, f.removed]).sort(), [['a.txt', 2, 1], ['new.txt', 2, 0]]);
  assert.match(await patch(dir, before, after, 'a.txt'), /\+TWO/);
  assert.equal(git(dir, 'status', '--porcelain').includes('a.txt'), true);
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '', 'the real index is untouched');
  assert.equal(await snapshotTree(os.tmpdir() + path.sep + 'does-not-exist'), null);
});

function harness(dir, lim = { enabled: true, maxLines: 5, maxFiles: 3, hardStop: false, margin: 50 }) {
  const sent = []; const out = []; const stopped = [];
  const a = { config: { id: 'claude', name: 'Claude', provider: 'claude' }, cwd: dir, cli: { stop: (p) => stopped.push(p), send: (p, t) => sent.push(t) } };
  const review = createReview({ limits: () => lim, emit: (m) => out.push(m), agent: () => a });
  return { a, review, sent, out, stopped };
}

test('an edit that crosses the budget never interrupts the job; the next task is held when the job ends', async () => {
  const dir = repo();
  const { a, review, stopped, out } = harness(dir);
  await review.begin(a);
  review.onEvent(a, { k: 'msg', role: 'assistant', done: true, text: 'Adding the helper.' });
  fs.writeFileSync(path.join(dir, 'big.txt'), Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n') + '\n');
  review.onEvent(a, { k: 'tool', id: 't1', name: 'Write', cls: 'edit', detail: { file_path: path.join(dir, 'big.txt'), content: 'x' }, status: 'done' });
  await new Promise((r) => setTimeout(r, 1500));
  let v = review.view('claude');
  assert.equal(v.lines, 8);
  assert.equal(v.held, false, 'still working: nothing is held or stopped mid-job');
  assert.deepEqual(stopped, []);
  assert.equal(v.changes[0].note, 'Adding the helper.');
  assert.doesNotThrow(() => review.guardSend(a));
  await review.onTurnEnd(a);
  v = review.view('claude');
  assert.equal(v.held, true);
  assert.deepEqual(stopped, [], 'the agent was never killed');
  assert.ok(out.some((m) => m.t === 'notice' && /Review needed/.test(m.text)));
  assert.throws(() => review.guardSend(a), /Review Claude's last job first/);
});

test('a job that stays under budget is not held, and the budget is part of the agent prompt', async () => {
  const dir = repo();
  const { a, review } = harness(dir);
  await review.begin(a);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  review.onEvent(a, { k: 'tool', id: 't1', name: 'Edit', cls: 'edit', detail: { file_path: 'a.txt', old_string: 'two', new_string: 'TWO' }, status: 'done' });
  await review.onTurnEnd(a);
  assert.equal(review.view('claude').held, false);
  assert.match(review.promptBlock(), /about 5 changed lines/);
  assert.match(review.promptBlock(), /split it into components/);
  const off = createReview({ limits: () => ({ enabled: false, maxLines: 5, maxFiles: 3 }), emit() {}, agent: () => a });
  assert.equal(off.promptBlock(), '');
});

test('approving starts a new batch, and an edit proposal goes to the agent without holding it', async () => {
  const dir = repo();
  const { a, review, sent } = harness(dir);
  await review.begin(a);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  review.onEvent(a, { k: 'tool', id: 't1', name: 'Edit', cls: 'edit', detail: { file_path: 'a.txt', old_string: 'one', new_string: 'changed' }, status: 'done' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(review.view('claude').lines, 4);
  review.propose(a, { kind: 'edit', file: 'a.txt', before: 'changed', after: 'better', note: 'nicer name' });
  assert.match(sent[0], /Nothing in your folder was changed/);
  assert.match(sent[0], /better/);
  assert.match(sent[0], /nicer name/);
  review.propose(a, { kind: 'ask', file: 'a.txt', code: 'changed', question: 'why?' });
  assert.match(sent[1], /do not edit files unless the user asks/);
  assert.throws(() => review.propose(a, { kind: 'edit', file: 'a.txt', before: '', after: '  ' }), /Edit the code/);
  const v = await review.approve(a);
  assert.equal(v.lines, 0);
  assert.equal(v.changes.length, 0);
  assert.equal(v.held, false);
});

test('parseHunks reads a unified diff into hunks of context, added and removed rows', async () => {
  const { parseHunks } = await import('../src/diff.js');
  const text = 'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@ intro\n one\n-two\n+TWO\n three\n+four\n@@ -20 +21 @@\n-x\n+y\n';
  const hunks = parseHunks(text);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].rows.map((r) => r.kind), ['ctx', 'del', 'add', 'ctx', 'add']);
  assert.equal(hunks[0].rows[2].text, 'TWO');
  assert.deepEqual(hunks[1].rows.map((r) => r.text), ['x', 'y']);
  assert.deepEqual(parseHunks(''), []);
});

test('the cutoff sits a margin above the budget and can be switched off', () => {
  assert.deepEqual(cutoffOf({ enabled: true, maxLines: 300, maxFiles: 10, hardStop: true, margin: 25 }), { enabled: true, maxLines: 375, maxFiles: 13 });
  assert.equal(cutoffOf({ enabled: true, maxLines: 300, maxFiles: 10, hardStop: false, margin: 25 }).enabled, false);
  assert.equal(cutoffOf({ enabled: false, maxLines: 300, maxFiles: 10, hardStop: true, margin: 25 }).enabled, false);
  assert.equal(cutoffOf({ enabled: true, maxLines: 20, maxFiles: 1, hardStop: true, margin: 5 }).maxFiles, 2);
});

test('past the cutoff the agent is cut off mid-job; under it, and with the cutoff off, it is not', async () => {
  const lots = (n) => Array.from({ length: n }, (_, i) => 'l' + i).join('\n');
  const on = { enabled: true, maxLines: 10, maxFiles: 5, hardStop: true, margin: 50 }; // cutoff 15 lines
  const h = harness(repo(), on);
  await h.review.begin(h.a);
  assert.equal(h.review.denyTool(h.a, 'Write', { file_path: 'b.txt', content: lots(12) }), null, '12 lines is over the budget but under the cutoff');
  assert.match(h.review.denyTool(h.a, 'Write', { file_path: 'b.txt', content: lots(20) }), /hard cutoff/);
  assert.equal(h.review.view('claude').held, true);
  assert.throws(() => h.review.guardSend(h.a), /Review Claude's last job first/);

  const dir2 = repo();
  const h2 = harness(dir2, on);
  await h2.review.begin(h2.a);
  fs.writeFileSync(path.join(dir2, 'big.txt'), lots(20) + '\n');
  h2.review.onEvent(h2.a, { k: 'tool', id: 't1', name: 'Write', cls: 'edit', detail: { file_path: 'big.txt', content: 'x' }, status: 'done' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(h2.stopped, ['claude'], 'stopped right after the edit that crossed the cutoff');

  const off = harness(repo(), { ...on, hardStop: false });
  assert.equal(off.review.denyTool(off.a, 'Write', { file_path: 'b.txt', content: lots(400) }), null);
  const unattended = harness(repo(), { ...on, enabled: false });
  assert.equal(unattended.review.denyTool(unattended.a, 'Write', { file_path: 'b.txt', content: lots(400) }), null);
  assert.equal(unattended.review.promptBlock(), '');
});
