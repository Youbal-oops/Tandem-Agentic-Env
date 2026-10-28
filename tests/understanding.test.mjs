import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';
import { applyNotes, delegationIn, freshBehavior, learnerNotes, loadBehavior, loadSkills, observedLines, readyIn, trackMessage } from '../server/learning/understanding.mjs';
import { workflowPrompt } from '../server/learning/workflow.mjs';

test('handing the thinking back is recognised in the ways people actually say it', () => {
  for (const text of ['you decide', 'Just do it', 'think of it on your own', 'whatever you think is best', "I don't care", 'up to you', 'stop asking me questions', 'use your best judgement', "your call", 'Surprise me']) {
    assert.ok(delegationIn(text), text);
  }
  for (const text of ['I would use a queue because the jobs can fail', 'Should I decide the retry count here?', 'The user decides which plan to pick', 'It makes sense to cache it']) {
    assert.equal(delegationIn(text), null, text);
  }
});

test('"READY TO BUILD" counts only as a line of the agent\'s own, with a real answer', () => {
  assert.equal(readyIn('Good.\nREADY TO BUILD: a 100 entry cache, tested against a full disk\nNext…'), 'a 100 entry cache, tested against a full disk');
  assert.equal(readyIn('**READY TO BUILD:** fix the typo'), 'fix the typo');
  assert.equal(readyIn('I will say READY TO BUILD: when you are done'), null);
  assert.equal(readyIn('READY TO BUILD: <one sentence stating the clear answer>'), null);
  assert.equal(readyIn('READY TO BUILD:'), null);
  assert.equal(readyIn('nothing here'), null);
});

test('learner notes are read from the end of a message, and bad lines are ignored', () => {
  const text = 'Nice reasoning.\n\n## Learner notes\n- skill: React = familiar (used hooks correctly, unsure about effects)\n- skill: SQL = new\n- skill: Rust = expert\n- behavior: reasons carefully but skips edge cases\n- something else\n';
  assert.deepEqual(learnerNotes(text), {
    skills: [{ name: 'React', level: 'familiar', evidence: 'used hooks correctly, unsure about effects' }, { name: 'SQL', level: 'new', evidence: '' }],
    behavior: ['reasons carefully but skips edge cases'],
  });
  assert.deepEqual(learnerNotes('no notes here'), { skills: [], behavior: [] });
  const followed = learnerNotes('## Learner notes\n- skill: Git = confident (rebases daily)\n\n## Teaching notes\n- skill: Ignored = new');
  assert.deepEqual(followed.skills.map((s) => s.name), ['Git']);
});

test('behavior is counted from the user\'s messages, and notes and skills are kept and bounded', () => {
  const b = freshBehavior();
  trackMessage(b, 'ok', { answering: true });
  trackMessage(b, 'you decide', { answering: true });
  trackMessage(b, 'I want to hurry, skip the questions', { answering: false });
  trackMessage(b, '   ');
  assert.equal(b.messages, 3); assert.equal(b.short, 2); assert.equal(b.delegations, 1); assert.equal(b.rushes, 1);

  const profile = { skills: {}, behavior: b };
  assert.equal(applyNotes(profile, { skills: [{ name: 'React', level: 'new', evidence: 'asked what a hook is' }], behavior: ['hands decisions back'] }, 100), true);
  assert.equal(applyNotes(profile, { skills: [{ name: 'React', level: 'new', evidence: 'asked what a hook is' }], behavior: ['hands decisions back'] }, 200), false, 'the same finding changes nothing');
  assert.equal(applyNotes(profile, { skills: [{ name: 'React', level: 'familiar', evidence: 'explained effects' }], behavior: [] }, 300), true);
  assert.equal(profile.skills.React.level, 'familiar');
  for (let i = 0; i < 80; i++) applyNotes(profile, { skills: [{ name: `Tech${i}`, level: 'new', evidence: '' }], behavior: [`note ${i}`] }, 1000 + i);
  assert.ok(Object.keys(profile.skills).length <= 60 && profile.behavior.notes.length <= 12);

  const lines = observedLines(profile).join('\n');
  assert.match(lines, /handed the decision back 1 time\b/);
  assert.match(lines, /Assessed skills/);
  assert.deepEqual(observedLines({ skills: {}, behavior: freshBehavior() }), []);
});

test('saved data is checked on the way back in', () => {
  assert.deepEqual(loadSkills({ React: { level: 'familiar', evidence: 'x', at: 5 }, Bad: { level: 'wizard' }, [`${'x'.repeat(50)}`]: { level: 'new' } }), { React: { level: 'familiar', evidence: 'x', at: 5 } });
  const b = loadBehavior({ messages: 4, delegations: -3, chars: 'many', notes: [{ note: 'ok', at: 1 }, 7] });
  assert.equal(b.messages, 4); assert.equal(b.delegations, 0); assert.equal(b.chars, 0); assert.deepEqual(b.notes, [{ note: 'ok', at: 1 }]);
});

test('the working method tells the agent to question, refuse hand-backs, wait to be satisfied and keep notes', () => {
  const text = workflowPrompt('claude');
  assert.match(text, /ONE question at a time/);
  assert.match(text, /Nobody answers for anyone else/);
  assert.match(text, /"you decide"/);
  assert.match(text, /READY TO BUILD: <one sentence/);
  assert.match(text, /## Learner notes/);
  assert.match(text, /do not write, edit or run anything that changes things|you do not write, edit or run anything that changes things/);
});

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const replies = (w, id) => w.snapshot()[id].events.filter((e) => e.k === 'msg').map((e) => e.text);
const users = (w, id) => w.snapshot()[id].events.filter((e) => e.k === 'user').map((e) => e.text);
const idle = (w, id) => !w.snapshot()[id].meta.busy;
const checkpoint = (w, id) => w.localState().checkpoints[id];

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-understanding-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const w = createWorkspace({ root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast() {} });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  return { w, root, repo };
}

test('in learning mode a message that hands the thinking back is refused, counted, and never makes the agent ready', async (t) => {
  const { w } = setup(t);
  w.setLearningMode(true);
  await w.action({ t: 'send', agent: 'codex', text: 'Add a cache, you decide how' });
  await waitFor(() => replies(w, 'codex').length === 1 && idle(w, 'codex'));
  assert.match(users(w, 'codex')[0], /not allowed to accept it/);
  assert.match(users(w, 'codex')[0], /"you decide"/);
  assert.equal(w.localState().learnerProfile.behavior.delegations, 1);
  assert.equal(checkpoint(w, 'codex').ready, false);
  assert.throws(() => w.action({ t: 'implement', agent: 'codex' }), /not satisfied yet/);

  // Outside learning mode nothing is added or counted.
  w.setLearningMode(false);
  await w.action({ t: 'send', agent: 'claude', text: 'you decide' });
  await waitFor(() => replies(w, 'claude').length === 1 && idle(w, 'claude'));
  assert.doesNotMatch(users(w, 'claude')[0], /Tandem:/);
});

test('the agent saying READY TO BUILD opens the gate, and the next thing the user says closes it again', async (t) => {
  const { w } = setup(t);
  w.setLearningMode(true);
  await w.action({ t: 'send', agent: 'claude', text: 'I would cache it in memory because reads dominate. RAW-REPLY:\nGood. One edge case first.' });
  await waitFor(() => replies(w, 'claude').length === 1 && idle(w, 'claude'));
  assert.equal(checkpoint(w, 'claude').ready, false);

  await w.action({ t: 'send', agent: 'claude', text: 'Evict the oldest when full. RAW-REPLY:\nREADY TO BUILD: an in-memory cache of 100 entries, oldest evicted when full' });
  await waitFor(() => replies(w, 'claude').length === 2 && idle(w, 'claude'));
  assert.equal(checkpoint(w, 'claude').ready, true);
  assert.match(checkpoint(w, 'claude').readyNote, /100 entries/);

  await w.action({ t: 'send', agent: 'claude', text: 'Actually make it persistent. RAW-REPLY:\nWhere would it be stored?' });
  await waitFor(() => replies(w, 'claude').length === 3 && idle(w, 'claude'));
  assert.equal(checkpoint(w, 'claude').ready, false, 'a change of mind means the agent has to be satisfied again');
});

test('what the agent concludes about the person is kept, saved and passed to every agent', async (t) => {
  const { w, root, repo } = setup(t);
  w.setLearningMode(true);
  await w.action({ t: 'send', agent: 'codex', text: 'I use useEffect for everything. RAW-REPLY:\nThat is a risk.\n\n## Learner notes\n- skill: React = familiar (reaches for effects too often)\n- behavior: gives an answer fast and skips failure cases' });
  await waitFor(() => replies(w, 'codex').length === 1 && idle(w, 'codex'));
  const profile = w.localState().learnerProfile;
  assert.equal(profile.skills.React.level, 'familiar');
  assert.equal(profile.behavior.notes[0].note, 'gives an answer fast and skips failure cases');

  // Another agent's prompt carries it.
  await w.action({ t: 'send', agent: 'claude', text: 'Plan a feature' });
  await waitFor(() => replies(w, 'claude').length === 1 && idle(w, 'claude'));
  assert.match(replies(w, 'claude')[0], /Assessed skills[^"]*React = familiar/);
  assert.match(replies(w, 'claude')[0], /gives an answer fast and skips failure cases/);

  // It survives a restart, and the profile dialog cannot overwrite it.
  w.saveLearnerProfile({ familiar: 'JS', learning: '', level: 'new' });
  assert.equal(w.localState().learnerProfile.skills.React.level, 'familiar');
  w.closeAll();
  const again = createWorkspace({ root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast() {} });
  t.after(() => again.closeAll());
  assert.equal(again.localState().learnerProfile.skills.React.level, 'familiar');
  assert.ok(again.localState().learnerProfile.behavior.messages >= 1);
});
