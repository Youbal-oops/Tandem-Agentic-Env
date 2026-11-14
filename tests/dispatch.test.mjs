import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GUIDE, buildPrompt, createDispatcher, dispatcherCandidates, parseDecision } from '../server/team-dispatch.mjs';
import { cleanTeam } from '../server/settings.mjs';

const CLAUDE = [{ id: 'opus', label: 'Claude Opus' }, { id: 'sonnet', label: 'Claude Sonnet' }, { id: 'haiku', label: 'Claude Haiku' }];
const CODEX = [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', about: 'Latest workhorse model.' }, { id: 'gpt-6-astra', label: 'GPT-6-Astra', about: 'Frontier intelligence for the most demanding work.' }, { id: 'gpt-6-luna', label: 'GPT-6-Luna', about: 'Fast and affordable model for easier tasks.' }];
const agent = (id, provider, models, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), provider, models, busy: false, available: true, mode: 'edit', turns: 0, ...extra });
const team = () => [agent('claude', 'claude', CLAUDE), agent('codex', 'codex', CODEX), agent('groq', 'api', [], { fixedModel: 'llama-3.1-8b-instant', endpoint: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY', mode: 'read' })];

test('the prompt carries the guide, the live team with model sizes, the task as data, and your own choices', () => {
  const p = buildPrompt({ guide: 'MY GUIDE', agents: team(), text: 'rename foo to bar', want: { tier: 'light' } });
  assert.ok(p.startsWith('MY GUIDE'));
  assert.match(p, /"id": "gpt-6-luna",\s+"name": "GPT-6-Luna",\s+"size": "light"/);
  assert.match(p, /chat-only/);
  assert.match(p, /already chose the size: "light"/);
  assert.match(p, /-----\nrename foo to bar\n-----/);
  assert.ok(buildPrompt({ guide: '', agents: team(), text: 'x' }).startsWith(DEFAULT_GUIDE.slice(0, 40)), 'an empty guide means the built-in one');
});

test('only answers that fit the real team are accepted', () => {
  const agents = team();
  const ok = parseDecision('Sure:\n```json\n{"agent":"codex","model":"gpt-6-luna","size":"light","reason":"A rename is  small."}\n```', agents);
  assert.deepEqual(ok, { agent: 'codex', name: 'Codex', model: 'gpt-6-luna', modelLabel: 'GPT-6-Luna', size: 'light', reason: 'A rename is small.', handoff: [], wait: false });
  // A model the agent does not have: the size it chose still stands, and the rules pick that agent's model for it.
  assert.equal(parseDecision('{"agent":"claude","model":"gpt-9","size":"heavy","reason":"x"}', agents).model, 'opus');
  assert.equal(parseDecision('{"agent":"groq","model":"anything","size":"light","reason":"x"}', agents).model, null, 'an API agent keeps its one model');
  assert.equal(parseDecision('{"agent":"nobody","model":null,"size":"light"}', agents), null);
  assert.equal(parseDecision('{"agent":"codex","size":"enormous"}', agents), null);
  assert.equal(parseDecision('I think Codex should do it.', agents), null);
  agents[1].busy = true;
  assert.equal(parseDecision('{"agent":"codex","model":null,"size":"light"}', agents), null, 'a busy agent cannot be chosen');
  // What you chose yourself cannot be overruled.
  assert.equal(parseDecision('{"agent":"claude","model":"haiku","size":"light"}', agents, { tier: 'heavy' }).size, 'heavy');
  assert.equal(parseDecision('{"agent":"claude","model":"haiku","size":"light"}', agents, { agent: 'groq' }), null);
});

test('the assistant is a standard model from the quickest agent that answers, and a failure falls through', async () => {
  const agents = team();
  assert.deepEqual(dispatcherCandidates(agents).map((c) => [c.agent.id, c.model.id]), [['claude', 'sonnet'], ['codex', 'gpt-6.1-sol'], ['groq', 'llama-3.1-8b-instant']]);
  assert.deepEqual(dispatcherCandidates(agents, 'codex').map((c) => c.agent.id), ['codex']);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"agent":"codex","model":"gpt-6-astra","size":"heavy","reason":"It is a redesign."}' } }] }) }; };
  const d = createDispatcher({ specs: {}, fetchImpl, env: { GROQ_API_KEY: 'k' } });
  const tried = [];
  const out = await d.decide({ guide: '', agents, text: 'redesign the sync engine', pin: 'groq', onTry: (who) => tried.push(who.name) });
  assert.deepEqual([out.decision.agent, out.decision.model, out.decision.size, out.by.name], ['codex', 'gpt-6-astra', 'heavy', 'Groq']);
  assert.deepEqual(tried, ['Groq']);
  assert.equal(calls[0].body.model, 'llama-3.1-8b-instant');
  assert.equal(calls[0].auth, 'Bearer k');
  assert.match(calls[0].body.messages[0].content, /redesign the sync engine/);
  // The API fails and the CLIs are not installed: no decision, with the reason, and the failed one is not retried at once.
  const down = createDispatcher({ specs: {}, fetchImpl: async () => ({ ok: false, status: 500 }) });
  const none = await down.decide({ guide: '', agents, text: 'x', pin: 'groq' });
  assert.equal(none.decision, null);
  assert.match(none.why, /could not answer/);
  let again = 0;
  await down.decide({ guide: '', agents, text: 'x', pin: 'groq', onTry: (who) => { if (who.name === 'Groq') again += 1; } });
  assert.equal(again, 0);
});

test('team settings accept only known values', () => {
  assert.deepEqual(cleanTeam({ dispatcher: 'rules', guide: 'g' }), { dispatcher: 'rules', guide: 'g', mode: 'dispatcher', coordinator: 'auto', coordinatorGuide: '' });
  assert.deepEqual(cleanTeam({ dispatcher: 'DROP TABLE', guide: 5 }), { dispatcher: 'auto', guide: '', mode: 'dispatcher', coordinator: 'auto', coordinatorGuide: '' });
  assert.equal(cleanTeam({ dispatcher: 'codex-1a2b' }).dispatcher, 'codex-1a2b');
  assert.equal(cleanTeam({ guide: 'x'.repeat(20000) }).guide.length, 12000);
});

test('the dispatcher sees the recent messages and is told to keep follow-ups with the same agent', () => {
  const p = buildPrompt({ guide: '', agents: team(), text: 'I meant the app itself', recent: [{ text: 'how do I ship it?', agent: 'codex', result: 'Build a release…' }] });
  assert.match(p, /RECENT MESSAGES IN THIS TEAM CHAT/);
  assert.match(p, /"handled_by": "codex"/);
  assert.match(DEFAULT_GUIDE, /Same area, same agent/);
  assert.doesNotMatch(buildPrompt({ guide: '', agents: team(), text: 'x' }), /RECENT MESSAGES/);
});
