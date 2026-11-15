import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, modelFor, pickAssignment, tierOfModel } from '../server/team.mjs';

const CLAUDE = [{ id: 'opus', label: 'Claude Opus' }, { id: 'sonnet', label: 'Claude Sonnet' }, { id: 'haiku', label: 'Claude Haiku' }];
const CODEX = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', about: 'Latest workhorse model for coding and everyday work.' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', about: 'Frontier intelligence for the most demanding work.' },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', about: 'Fast and affordable model for easier tasks.' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', about: 'Older fast and efficient model.' },
  { id: 'codex-auto-review', label: 'Codex Auto Review', about: 'Automatic approval review model for Codex.' },
];
const AGY = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low'].map((id) => ({ id }));
const agent = (id, provider, models, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), provider, models, busy: false, available: true, mode: 'edit', turns: 0, ...extra });

test('models are sized from their names and what the provider says about them', () => {
  assert.equal(tierOfModel('haiku'), 'light');
  assert.equal(tierOfModel('sonnet'), 'standard');
  assert.equal(tierOfModel('claude-fable-5-2'), 'heavy');
  assert.equal(tierOfModel('gemini-4-argon-high'), 'heavy');
  assert.equal(tierOfModel('gpt-6-astra', 'Frontier intelligence for the most demanding work.'), 'heavy');
  assert.equal(tierOfModel('gpt-6-luna', 'Fast and affordable model for easier tasks.'), 'light');
  assert.equal(tierOfModel('codex-auto-review'), null, 'not a model to hand tasks to');
});

test('each task size gets the matching model, the newest one, at a fitting reasoning level', () => {
  assert.equal(modelFor(CLAUDE, 'light').id, 'haiku');
  assert.equal(modelFor(CLAUDE, 'heavy').id, 'opus');
  assert.equal(modelFor(CODEX, 'light').id, 'gpt-6-luna', 'not the older one');
  assert.equal(modelFor(CODEX, 'standard').id, 'gpt-6.1-sol');
  assert.equal(modelFor(CODEX, 'heavy').id, 'gpt-6-astra');
  assert.equal(modelFor(AGY, 'light').id, 'gemini-3.8-flash-low');
  assert.equal(modelFor(AGY, 'standard').id, 'gemini-4-hydrogen-medium');
  assert.equal(modelFor(AGY, 'heavy').id, 'gemini-4-argon-high');
  // No light model: the nearest bigger one, marked as not exact. No list at all: the agent keeps its own default.
  assert.deepEqual(modelFor([{ id: 'sonnet' }, { id: 'opus' }], 'light'), { id: 'sonnet', label: 'sonnet', tier: 'standard', exact: false });
  assert.equal(modelFor([], 'heavy'), null);
});

test('tasks are sized by what they ask for', () => {
  assert.deepEqual([classifyTask('fix the typo in the README title').tier, classifyTask('fix the typo in the README title').kind], ['light', 'change']);
  assert.equal(classifyTask('Add a dark mode toggle to the settings page and save the choice').tier, 'standard');
  assert.equal(classifyTask('Refactor the auth module to use sessions').tier, 'heavy');
  assert.equal(classifyTask('find the root cause of the flaky login test').tier, 'heavy');
  assert.deepEqual([classifyTask('what does this file do?').tier, classifyTask('what does this file do?').kind], ['light', 'question']);
  assert.equal(classifyTask('x'.repeat(1000)).tier, 'heavy');
  assert.equal(classifyTask('Do this:\n1. a\n2. b\n3. c\n4. d\n5. e').tier, 'heavy');
});

test('a light task goes to a small model and a heavy one to the strongest, on a free agent', () => {
  const agents = [agent('claude', 'claude', CLAUDE), agent('codex', 'codex', CODEX), agent('agy', 'antigravity', AGY)];
  const light = pickAssignment({ text: 'rename the Save button to Store', agents });
  assert.equal(light.tier, 'light');
  assert.equal(light.model, 'haiku');
  assert.match(light.reason, /Light task: it is a small text change\. Claude is free and will use Claude Haiku\./);
  const heavy = pickAssignment({ text: 'Redesign the sync engine so it survives going offline', agents });
  assert.deepEqual([heavy.tier, heavy.model], ['heavy', 'opus']);
  // Work is spread: with the first agent busy and the second already used more, the third gets it.
  agents[0].busy = true; agents[1].turns = 5;
  assert.equal(pickAssignment({ text: 'rename the Save button to Store', agents }).agent, 'agy');
});

test('your own choices win, busy agents are skipped, and chat-only models do not get changes', () => {
  const api = agent('groq', 'api', [], { fixedModel: 'llama-3.3-70b', mode: 'read' });
  const agents = [api, agent('codex', 'codex', CODEX, { mode: 'read' })];
  const change = pickAssignment({ text: 'add a retry to the upload', agents });
  assert.equal(change.agent, 'codex', 'the API chat cannot edit files');
  assert.match(change.note, /read-only mode/);
  assert.equal(pickAssignment({ text: 'explain the upload retry', agents: [api] }).model, null, 'an API agent keeps its one model');
  const forced = pickAssignment({ text: 'add a retry to the upload', agents, want: { agent: 'groq', tier: 'heavy' } });
  assert.deepEqual([forced.agent, forced.tier], ['groq', 'heavy']);
  assert.match(forced.reason, /your choice/);
  assert.match(forced.note, /chat-only/);
  agents[1].busy = true;
  assert.match(pickAssignment({ text: 'x', agents, want: { agent: 'codex' } }).error, /still working/);
  agents[0].busy = true;
  assert.match(pickAssignment({ text: 'x', agents }).error, /Every agent is busy/);
  assert.match(pickAssignment({ text: 'x', agents: [] }).error, /No AI account is connected/);
});

test('asking for ideas is a question, even when it names a change', () => {
  for (const t of ['thats just setup i ment as a software what else should i add to refine it', 'any ideas to improve the login page', 'should I add caching here', 'can you suggest features to add']) assert.equal(classifyTask(t).kind, 'question', t);
  assert.equal(classifyTask('add caching to the login page').kind, 'change');
  assert.equal(classifyTask('what is broken here, and then fix it').kind, 'change');
});

test('a follow-up goes back to the agent that answered the last message, if it is free', () => {
  const agents = [agent('claude', 'claude', CLAUDE), agent('codex', 'codex', CODEX), agent('agy', 'antigravity', AGY)];
  const recent = [{ text: 'how do I publish this to the Play Store?', agent: 'codex', result: '1. Build a production release…' }];
  const follow = pickAssignment({ text: 'thats just setup i ment as a software what else should i add to refine it', agents, recent });
  assert.equal(follow.agent, 'codex');
  assert.equal(follow.followUp, true);
  assert.match(follow.reason, /follows on from your last message, so Codex keeps that conversation/);
  assert.equal(follow.note, '', 'a question gets no "it will only propose the change" warning');
  assert.equal(pickAssignment({ text: 'Refactor the payment module to use the new API client', agents, recent }).followUp, false, 'a new task is not a follow-up');
  assert.equal(pickAssignment({ text: 'also do the same for settings', agents, recent: [] }).followUp, false, 'nothing to follow');
  agents[1].busy = true;
  assert.notEqual(pickAssignment({ text: 'also do the same for settings', agents, recent }).agent, 'codex', 'a busy agent is not waited for');
  agents[1].busy = false;
  assert.equal(pickAssignment({ text: 'also do the same for settings', agents, recent, want: { agent: 'claude' } }).agent, 'claude', 'your own choice still wins');
});

test('a request with several parts is never "light", whatever small words it uses', () => {
  assert.equal(classifyTask('Do two independent things: summarise the README, and list every file with a one-line guess. Then tell me which is more complete.').tier, 'standard');
  assert.equal(classifyTask('fix the typo in the README title, then bump the version').tier, 'standard');
  assert.equal(classifyTask('fix the typo in the README title').tier, 'light', 'a single small thing still is');
  assert.equal(classifyTask('rename foo and bar to baz').tier, 'light', '"and" alone does not make it two requests');
});
