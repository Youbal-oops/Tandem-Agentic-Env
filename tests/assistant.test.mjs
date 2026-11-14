import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseDecision, dispatcherCandidates, DEFAULT_GUIDE } from '../server/team-dispatch.mjs';
import { agentBrief, composeHandoff, combineAnswer, requestOf, REQUEST_MARK } from '../server/team-handoff.mjs';
import { cleanTeam } from '../server/settings.mjs';
import { cleanTeamChat } from '../server/team-chat.mjs';

const MODELS = [
  { id: 'big', label: 'Big', about: 'Most capable model for hard problems.' },
  { id: 'mid', label: 'Mid', about: 'Latest workhorse model for coding.' },
  { id: 'tiny', label: 'Tiny', about: 'Fast and affordable model for easier tasks.' },
];
const agent = (id, provider, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), provider, models: MODELS, busy: false, available: true, mode: 'edit', turns: 0, brief: { status: 'idle', task: '', answer: '', files: [] }, ...extra });
const ui = { status: 'working', task: 'Build the contacts screen', answer: 'Calling GET /api/contacts', files: ['src/Contacts.tsx'] };

test('an agent brief comes from its chat: last task, latest answer, files it changed, and whether it is busy', () => {
  const snap = { events: [{ k: 'user', text: `${REQUEST_MARK}\nBuild it` }, { k: 'msg', text: 'Done, see Contacts.tsx' }], meta: { busy: true, stats: { touched: [{ p: 'a.ts' }, { p: 'b.ts' }] } } };
  assert.deepEqual(agentBrief(snap), { status: 'working', task: 'Build it', answer: 'Done, see Contacts.tsx', files: ['a.ts', 'b.ts'] });
  assert.equal(agentBrief({ events: [], meta: {} }).status, 'new, nothing done yet');
  assert.equal(agentBrief({ events: [{ k: 'user', text: 'x' }], meta: { awaiting: true } }).status, 'waiting for the user to approve something');
});

test('the prompt shows what every agent is doing, and teaches handoff and asking', () => {
  const p = buildPrompt({ guide: DEFAULT_GUIDE, agents: [agent('codex', 'codex', { busy: true, brief: ui }), agent('claude', 'claude')], text: 'backend please', want: {}, recent: [] });
  assert.match(p, /"working_on": "Build the contacts screen"/);
  assert.match(p, /src\/Contacts.tsx/);
  assert.match(p, /"handoff"/);
  assert.match(p, /"ask"/);
  assert.doesNotMatch(p, /break.*into tasks/i, 'the assistant does not plan projects');
});

test('a decision keeps only real handoff sources, never the receiving agent, and can be a question', () => {
  const team = [agent('codex', 'codex', { busy: true, brief: ui }), agent('claude', 'claude'), agent('antigravity', 'antigravity')];
  const d = parseDecision(JSON.stringify({ agent: 'claude', model: 'big', size: 'heavy', reason: 'SQL', handoff: [{ from: 'codex', why: 'api shape' }, { from: 'claude', why: 'self' }, { from: 'ghost', why: 'x' }] }), team);
  assert.equal(d.agent, 'claude'); assert.equal(d.model, 'big');
  assert.deepEqual(d.handoff, [{ from: 'codex', why: 'api shape' }]);
  assert.equal(parseDecision('{"agent": "codex", "size": "light"}', team), null, 'a busy agent cannot be chosen');
  assert.deepEqual(parseDecision('{"agent": null, "ask": "Which module?"}', team), { ask: 'Which module?' });
  assert.equal(parseDecision('{"agent": null, "ask": "Which?"}', team, { agent: 'claude' }), null, 'no questions when the user chose the agent');
});

test('the assistant model is a standard one by default', () => {
  const team = [agent('claude', 'claude')];
  assert.equal(dispatcherCandidates(team)[0].model.tier, 'standard');
  assert.equal(dispatcherCandidates(team, 'auto', 'light')[0].model.tier, 'light');
});

test('a handoff carries the other agent task, files and answer, and nothing for agents that did nothing', () => {
  const team = [agent('codex', 'codex', { brief: ui }), agent('claude', 'claude'), agent('antigravity', 'antigravity')];
  const h = composeHandoff({ handoff: [{ from: 'codex', why: 'match the API' }, { from: 'antigravity', why: 'nothing yet' }, { from: 'nobody' }], roster: team, sharedDir: '/s' });
  assert.deepEqual(h.from.map((f) => f.id), ['codex']);
  assert.match(h.text, /Build the contacts screen/); assert.match(h.text, /src\/Contacts.tsx/); assert.match(h.text, /GET \/api\/contacts/); assert.match(h.text, /\/s/);
  assert.ok(h.text.endsWith(REQUEST_MARK));
  assert.equal(composeHandoff({ handoff: [{ from: 'antigravity' }], roster: team }), null);
  assert.equal(requestOf(`${h.text}\nAdd the API`), 'Add the API');
});

test('an answer is joined with the request and the question it answers', () => {
  const t = combineAnswer({ text: 'fix it', asked: 'Fix what?' }, 'the login bug');
  assert.match(t, /fix it/); assert.match(t, /Fix what\?/); assert.match(t, /the login bug/);
  assert.equal(combineAnswer({ text: 'x' }, 'y'), null);
});

test('settings default to the assistant and the chat remembers questions and handoffs', () => {
  assert.equal(cleanTeam({}).mode, 'dispatcher');
  const [e] = cleanTeamChat([{ id: '1', text: 'fix it', at: 1, state: 'asked', asked: 'Fix what?', handoff: [{ id: 'codex', name: 'Codex', why: 'api' }, { bad: 1 }] }]);
  assert.equal(e.asked, 'Fix what?'); assert.deepEqual(e.handoff, [{ id: 'codex', name: 'Codex', why: 'api' }]);
});

import { createAgentRoutes } from '../server/app/routes/agent.mjs';

function routeHarness(decision, extra = {}) {
  const sent = []; const replies = [];
  const cfgs = [{ id: 'codex', name: 'Codex', provider: 'codex' }, { id: 'claude', name: 'Claude', provider: 'claude' }];
  const snap = {
    codex: { meta: { busy: true, available: true, mode: 'edit', stats: { touched: [{ p: 'src/Contacts.tsx' }] } }, events: [{ k: 'user', text: 'Build the contacts screen' }, { k: 'msg', text: 'Calling GET /api/contacts' }] },
    claude: { meta: { busy: false, available: true, mode: 'edit' }, events: [] },
  };
  const agents = {
    configs: () => cfgs, snapshot: () => snap, settings: () => ({ team: { dispatcher: 'auto', guide: '', mode: 'dispatcher' } }), sharedDir: () => '/shared',
    action: async (m) => { sent.push(m); },
  };
  const dispatcher = { decide: async () => ({ decision, by: { name: 'Claude', modelLabel: 'Sonnet' } }) };
  const routes = createAgentRoutes({ agents, hub: {}, snapshot: () => ({}), dispatcher, modelCatalog: () => ({ claude: MODELS, codex: MODELS }), ...extra });
  return { sent, replies, send: (m) => routes.handlers['team-send']({ request: 1, ...m }, { send: (x) => replies.push(x) }) };
}

test('the route hands the other agent\'s work to the agent that gets the message', async () => {
  const h = routeHarness({ agent: 'claude', name: 'Claude', model: 'mid', modelLabel: 'Mid', size: 'standard', reason: 'Backend is a different area.', handoff: [{ from: 'codex', why: 'match the API' }] });
  await h.send({ text: 'Now the backend and SQL migrations.' });
  const sent = h.sent.find((m) => m.t === 'send');
  assert.equal(sent.agent, 'claude');
  assert.match(sent.text, /Build the contacts screen/); assert.match(sent.text, /src\/Contacts.tsx/); assert.ok(sent.text.endsWith('Now the backend and SQL migrations.'));
  assert.deepEqual(h.replies.at(-1).assignment.handoff.map((x) => x.id), ['codex']);
});

test('the route relays a question, then routes the answer together with the request', async () => {
  const h = routeHarness({ ask: 'Fix what?' });
  await h.send({ text: 'fix it' });
  assert.equal(h.replies.at(-1).asked, 'Fix what?'); assert.equal(h.sent.length, 0, 'nothing is sent while a question is open');
  const h2 = routeHarness({ agent: 'claude', name: 'Claude', model: null, modelLabel: 'x', size: 'standard', reason: 'r', handoff: [] });
  await h2.send({ text: 'the login bug', answering: true, recent: [{ text: 'fix it', asked: 'Fix what?' }] });
  const t = h2.sent.find((m) => m.t === 'send').text;
  assert.match(t, /fix it/); assert.match(t, /the login bug/);
});

import { createHolds } from '../server/team-holds.mjs';

test('a busy agent that has the context can be waited for, but only when the assistant says so', () => {
  const team = [agent('claude', 'claude', { busy: true, brief: ui }), agent('codex', 'codex')];
  const reply = (wait) => JSON.stringify({ agent: 'claude', model: 'big', size: 'heavy', reason: 'it did the design', wait });
  assert.equal(parseDecision(reply(false), team), null);
  assert.equal(parseDecision(reply(true), team).wait, true);
  assert.equal(parseDecision(reply(true), team, { agent: 'claude' }), null, 'when you pick the agent, nothing is held');
  assert.equal(parseDecision(JSON.stringify({ agent: 'codex', size: 'light', wait: true }), team).wait, false, 'a free agent is never waited for');
  assert.match(buildPrompt({ guide: DEFAULT_GUIDE, agents: team, text: 'x' }), /"wait"/);
});

test('a held message is sent when the agent has been idle for a moment, with the other agents\' context', async () => {
  const meta = { busy: true }; const sent = []; const out = [];
  const roster = [agent('claude', 'claude', { current: 'mid' }), agent('codex', 'codex', { brief: ui })];
  let t = 1;
  const holds = createHolds({ workspace: { snapshot: () => ({ claude: { meta } }), action: async (m) => { sent.push(m); }, sharedDir: () => '/s' }, getRoster: () => roster, emit: (m) => out.push(m), schedule: () => {}, every: () => 0, now: () => t, coolMs: 100 });
  holds.add({ id: 'e1', agent: 'claude', name: 'Claude', model: 'big', modelLabel: 'Big', text: 'Add the index', handoff: [{ from: 'codex', why: 'ui' }] });
  holds.tick(); assert.equal(sent.length, 0, 'still busy');
  meta.busy = false; holds.tick(); assert.equal(sent.length, 0, 'just stopped: its process is still shutting down');
  t = 200; holds.tick(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.map((m) => m.t), ['model', 'send']);
  assert.match(sent[1].text, /Build the contacts screen/); assert.ok(sent[1].text.endsWith('Add the index'));
  assert.equal(out[0].entryId, 'e1'); assert.equal(out[0].released.agent, 'claude');
  assert.deepEqual(holds.ids(), []);
  holds.add({ id: 'e2', agent: 'claude', name: 'Claude', text: 'x' }); assert.ok(holds.cancel('e2')); assert.equal(holds.has('e2'), false);
});

test('the route holds a message for a busy agent and says so', async () => {
  const added = [];
  const h = routeHarness({ agent: 'codex', name: 'Codex', model: null, modelLabel: 'Mid', size: 'heavy', reason: 'It did the earlier work.', handoff: [], wait: true }, { holds: { add: (x) => added.push(x) } });
  await h.send({ text: 'continue the schema', entryId: 'e9' });
  assert.equal(h.sent.filter((m) => m.t === 'send').length, 0);
  assert.equal(added[0].id, 'e9'); assert.equal(added[0].agent, 'codex');
  assert.equal(h.replies.at(-1).assignment.held, true);
});
