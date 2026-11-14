import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';
import { COORDINATOR_GUIDE, buildPlanPrompt, buildSummaryPrompt, createCoordinator, parsePlan, plainSummary, plannerCandidates, restoreRuns } from '../server/team-coordinator.mjs';
import { cleanTeam } from '../server/settings.mjs';
import { STARTERS } from './fixtures/starters.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const CLAUDE = [{ id: 'opus', label: 'Claude Opus' }, { id: 'sonnet', label: 'Claude Sonnet' }, { id: 'haiku', label: 'Claude Haiku' }];
const CODEX = [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', about: 'Latest workhorse model.' }, { id: 'gpt-6-astra', label: 'GPT-6-Astra', about: 'Frontier intelligence for the most demanding work.' }, { id: 'gpt-6-luna', label: 'GPT-6-Luna', about: 'Fast and affordable model for easier tasks.' }];
const CATALOG = { claude: CLAUDE, codex: CODEX, gemini: [], antigravity: [] };
const agent = (id, provider, models, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), provider, models, busy: false, available: true, mode: 'edit', turns: 0, ...extra });
const team = () => [agent('claude', 'claude', CLAUDE), agent('codex', 'codex', CODEX)];

test('the plan prompt carries the guide, the live team, what is running, and the request as data', () => {
  const p = buildPlanPrompt({ guide: 'MY GUIDE', agents: team(), text: 'add dark mode', recent: [{ text: 'earlier', agent: 'codex', result: 'did it' }], runs: [{ status: 'running', goal: 'g', tasks: [{ title: 'x', agent: 'codex', state: 'running' }] }], shared: ['plan.md'] });
  assert.ok(p.startsWith('MY GUIDE'));
  assert.match(p, /"can_edit": true/);
  assert.match(p, /PLANS ALREADY RUNNING/);
  assert.match(p, /FILES IN THE SHARED TEAM FOLDER: plan\.md/);
  assert.match(p, /-----\nadd dark mode\n-----/);
  assert.ok(buildPlanPrompt({ guide: '', agents: team(), text: 'x' }).startsWith(COORDINATOR_GUIDE.slice(0, 50)), 'an empty guide means the built-in one');
  assert.match(COORDINATOR_GUIDE, /never more than 6/);
});

test('only plans that fit the real team are accepted, and each task gets a real agent and model', () => {
  const agents = team();
  const reply = 'Here you go:\n```json\n' + JSON.stringify({ reply: 'On it.', ask: null, tasks: [
    { id: 'design', title: 'Design the export format', agent: 'claude', model: 'opus', size: 'heavy', prompt: 'Write a spec', after: [] },
    { id: 'build', title: 'Build it', agent: 'Codex', model: 'not-a-model', size: 'standard', prompt: 'Implement the spec', after: ['design', 'ghost', 'build'] },
    { id: 'x', title: 'Ghost agent', agent: 'nobody', size: 'light', prompt: 'fix a typo in the README', after: [] },
    { id: 'empty', agent: 'claude', prompt: '   ' },
  ] }) + '\n```';
  const plan = parsePlan(reply, agents);
  assert.equal(plan.reply, 'On it.');
  assert.deepEqual(plan.tasks.map((t) => [t.id, t.agent, t.model, t.size, t.after]), [
    ['design', 'claude', 'opus', 'heavy', []],
    ['build', 'codex', 'gpt-6.1-sol', 'standard', ['design']], // an invented model becomes the real model for its size; unknown and self references are dropped
    ['x', 'claude', 'haiku', 'light', []], // an agent that does not exist is replaced by the rules' choice
  ]);
  assert.equal(parsePlan('I think Claude should do it.', agents), null);
  assert.equal(parsePlan('{"tasks": [{"prompt": "x", "agent": "claude"}]}'.replace('x', 'a'.repeat(7000)), agents).tasks[0].prompt.length, 6000);
  assert.equal(parsePlan(JSON.stringify({ tasks: Array.from({ length: 12 }, (_, i) => ({ agent: 'claude', prompt: `p${i}` })) }), agents).tasks.length, 6);
  const talk = parsePlan('{"reply": "Codex did it last time.", "tasks": []}', agents);
  assert.deepEqual([talk.tasks.length, talk.reply], [0, 'Codex did it last time.']);
  assert.equal(parsePlan('{"ask": "Which screen?", "tasks": []}', agents).ask, 'Which screen?');
  agents[1].available = false;
  assert.equal(parsePlan(JSON.stringify({ tasks: [{ agent: 'codex', prompt: 'do it' }] }), agents).tasks[0].agent, 'claude', 'an agent that is not signed in gets nothing');
});

test('the coordinator model is the standard one of the first agent that is signed in (Codex first, as measured), or the one you pin', () => {
  const agents = [agent('codex', 'codex', CODEX), agent('claude', 'claude', CLAUDE), agent('agy', 'antigravity', [{ id: 'gemini-4-hydrogen-medium' }, { id: 'gemini-4-argon-high' }])];
  assert.deepEqual(plannerCandidates(agents).map((c) => [c.agent.id, c.model.id]), [['codex', 'gpt-6.1-sol'], ['claude', 'sonnet'], ['agy', 'gemini-4-hydrogen-medium']]);
  assert.deepEqual(plannerCandidates(agents, { tier: 'heavy' }).map((c) => c.model.id), ['gpt-6-astra', 'opus', 'gemini-4-argon-high'], 'a stronger tier can be asked for');
  assert.deepEqual(plannerCandidates(agents, { pin: 'codex' }).map((c) => c.agent.id), ['codex']);
  agents[0].available = false;
  assert.equal(plannerCandidates(agents)[0].agent.id, 'claude', 'a signed-out agent is skipped');
});

test('team settings accept the coordinator options and nothing else', () => {
  assert.deepEqual(cleanTeam({ mode: 'dispatcher', coordinator: 'codex', coordinatorGuide: 'g' }), { dispatcher: 'auto', guide: '', mode: 'dispatcher', coordinator: 'codex', coordinatorGuide: 'g' });
  assert.equal(cleanTeam({ mode: 'chaos', coordinator: 'a b' }).mode, 'dispatcher');
  assert.equal(cleanTeam({ coordinator: 'a b' }).coordinator, 'auto');
});

test('saved plans come back with anything that was running marked as interrupted', () => {
  const [run] = restoreRuns([{ id: 'r1', status: 'running', tasks: [{ id: 't1', state: 'running', doing: 'x' }, { id: 't2', state: 'done' }, { id: 't3', state: 'pending' }] }, { junk: true }]);
  assert.equal(run.status, 'stopped');
  assert.deepEqual(run.tasks.map((t) => t.state), ['failed', 'done', 'failed']);
  assert.match(run.tasks[0].error, /closed while/);
  assert.match(plainSummary({ tasks: [{ title: 'A', name: 'Claude', state: 'done' }, { title: 'B', name: 'Codex', state: 'failed', error: 'oops' }] }), /1 of 2 tasks finished[\s\S]*B\*\* \(Codex\): failed, oops/);
  assert.match(buildSummaryPrompt({ text: 'do it', tasks: [{ title: 'A', name: 'Claude', modelLabel: 'Opus', state: 'done', result: 'ok' }] }), /THE USER'S REQUEST: do it[\s\S]*"result": "ok"/);
});

// ------------------------------------------------------------------ a whole plan, run by fixture agents
function harness(t, { specsOver = {}, asks, cool = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-coord-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const specs = Object.fromEntries(['claude', 'codex', 'gemini', 'antigravity'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
  Object.assign(specs, specsOver);
  const sent = []; const published = [];
  let coord = null;
  const w = createWorkspace({ initialAgents: STARTERS, root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast: (m) => coord?.observe(m) });
  w.add({ id: 'gem', name: 'Gem', provider: 'gemini' });
  coord = createCoordinator({ workspace: w, catalog: () => CATALOG, emit: (m) => published.push(m), every: () => null, coolMs: cool,
    ask: async (cand, prompt) => { sent.push({ by: cand.agent.id, prompt }); return asks.shift()(prompt, cand); } });
  t.after(async () => { coord.close(); w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  const finalRun = () => published.filter((m) => m.t === 'team-run').at(-1)?.run;
  const done = async () => { const end = Date.now() + 15000; while (!['done', 'partial', 'failed', 'stopped'].includes(finalRun()?.status)) { if (Date.now() > end) throw new Error('timed out: ' + JSON.stringify(finalRun()?.tasks.map((x) => [x.id, x.state, x.error]))); await new Promise((r) => setTimeout(r, 30)); } return finalRun(); };
  return { w, coord, sent, published, done, root, repo };
}

test('a plan runs in the background: independent tasks together, dependent ones after, then a report', async (t) => {
  const plan = { reply: 'Claude designs while Gem checks the docs; Codex builds once the design is in.', tasks: [
    { id: 'design', title: 'Design it', agent: 'claude', model: 'opus', size: 'heavy', prompt: 'DESIGN-PROMPT', after: [] },
    { id: 'docs', title: 'Check the docs', agent: 'gem', size: 'light', prompt: 'DOCS-PROMPT', after: [] },
    { id: 'build', title: 'Build it', agent: 'codex', model: 'gpt-6.1-sol', size: 'standard', prompt: 'BUILD-PROMPT', after: ['design'] },
  ] };
  const h = harness(t, { asks: [() => JSON.stringify(plan), () => 'Everything finished: **design**, docs and the build.'] });
  const out = await h.coord.plan({ text: 'Add export and update the docs', recent: [] });
  assert.ok(out.run, 'planned');
  assert.equal(out.run.by, 'Planned by Codex on GPT-6.1-Sol');
  const first = h.published.filter((m) => m.t === 'team-run').map((m) => m.run).find((r) => r.tasks.some((x) => x.state === 'running'));
  assert.deepEqual(first.tasks.map((x) => [x.id, x.state]), [['design', 'running'], ['docs', 'running'], ['build', 'pending']], 'the independent tasks start together; the dependent one waits');
  const run = await h.done();
  assert.equal(run.status, 'done');
  assert.deepEqual(run.tasks.map((x) => x.state), ['done', 'done', 'done']);
  assert.match(run.summary, /Everything finished/);
  // The dependent task was given what the task before it produced, and the shared folder and plan file.
  const build = JSON.parse(h.w.snapshot().codex.events.filter((e) => e.k === 'msg').at(-1).text);
  assert.match(build.text, /BUILD-PROMPT/);
  assert.match(build.text, /What the tasks you depend on produced:\n--- Design it \(Claude\)/);
  assert.match(build.text, /"--model","opus"/, 'the earlier answer itself (the fixture echoes how it was started) is passed on');
  assert.match(build.text, /The plan itself is in [^\n]*plans[^\n]*\.md/, 'and the plan file it can read');
  assert.match(build.text, /Shared team folder/);
  assert.equal(h.w.snapshot().claude.meta.modelPref, 'opus', 'the planned model was set on the agent');
  const files = fs.readdirSync(path.join(h.repo, '.tandem', 'shared', 'plans'));
  assert.equal(files.length, 1);
  assert.match(fs.readFileSync(path.join(h.repo, '.tandem', 'shared', 'plans', files[0]), 'utf8'), /Build it\*\* \[done\] — Codex, GPT-6\.1-Sol, after design/);
  assert.equal(h.sent.length, 2, 'one call to plan, one for the report');
  assert.equal(h.w.teamRuns().length, 1, 'the plan is kept with the repository');
});

test('a task whose agent cannot start is given to another agent, once', async (t) => {
  const failer = path.join(os.tmpdir(), `tandem-fail-${process.pid}.mjs`);
  fs.writeFileSync(failer, "process.stderr.write('not signed in\\n'); process.exit(1);\n");
  t.after(() => fs.rmSync(failer, { force: true }));
  const plan = { reply: 'Gem does it.', tasks: [{ id: 'a', title: 'Do it', agent: 'gem', size: 'standard', prompt: 'DO-IT', after: [] }] };
  const h = harness(t, { specsOver: { gemini: { file: process.execPath, args: [failer] } }, asks: [() => JSON.stringify(plan), () => 'Done by someone else.'] });
  await h.coord.plan({ text: 'do it', recent: [] });
  const run = await h.done();
  assert.equal(run.tasks[0].state, 'done');
  assert.notEqual(run.tasks[0].agent, 'gem', 'it moved to an agent that works');
  assert.match(run.tasks[0].rerouted, /Gem could not do it/);
});

test('a failed task can be run again, and what was skipped because of it comes back', async (t) => {
  const h = harness(t, { asks: [() => 'unused'] });
  const run = { id: 'r1', at: 1, text: 'x', goal: 'g', status: 'partial', tasks: [
    { id: 'a', title: 'A', agent: 'claude', name: 'Claude', size: 'light', prompt: 'A-PROMPT', after: [], state: 'failed', error: 'boom' },
    { id: 'b', title: 'B', agent: 'codex', name: 'Codex', size: 'light', prompt: 'B-PROMPT', after: ['a'], state: 'skipped', error: 'Skipped' },
  ] };
  h.w.teamRuns().push(run);
  assert.equal(h.coord.retry('r1', 'a'), true);
  assert.equal(h.coord.retry('r1', 'nope'), false);
  const end = await h.done();
  assert.deepEqual(end.tasks.map((x) => x.state), ['done', 'done']);
});

test('a plan that cannot be made falls back, and a question is answered without a plan', async (t) => {
  const h = harness(t, { asks: [() => 'sorry, no JSON here', () => 'still none'] });
  const out = await h.coord.plan({ text: 'x', recent: [] });
  assert.match(out.fallback, /did not give a usable plan/);
  const h2 = harness(t, { asks: [() => JSON.stringify({ reply: 'Codex built the export last time.', tasks: [] })] });
  const talk = await h2.coord.plan({ text: 'who did the export?', recent: [] });
  assert.equal(talk.run.tasks.length, 0);
  assert.equal(talk.run.status, 'done');
  assert.equal(talk.run.reply, 'Codex built the export last time.');
});

test('an agent that is signed out is left out of the team, so nothing is planned onto it', async () => {
  const { buildRoster } = await import('../server/team-roster.mjs');
  const fake = { snapshot: () => ({ claude: { meta: {} }, codex: { meta: {} } }), configs: () => [{ id: 'claude', name: 'Claude', provider: 'claude' }, { id: 'codex', name: 'Codex', provider: 'codex' }] };
  assert.deepEqual(buildRoster(fake, {}, () => ({ claude: false, codex: true })).map((a) => [a.id, a.available]), [['claude', false], ['codex', true]]);
  assert.deepEqual(buildRoster(fake, {}).map((a) => a.available), [true, true], 'with no check yet, everything installed counts');
  assert.deepEqual(buildRoster(fake, {}, () => ({ claude: null })).map((a) => a.available), [true, true], 'an unknown sign-in state is not held against it');
});

test('an agent is given its next task only after a pause, and an empty answer with an error is a failure', async (t) => {
  const plan = { reply: 'Two in a row for Claude.', tasks: [
    { id: 'a', title: 'First', agent: 'claude', size: 'light', prompt: 'FIRST', after: [] },
    { id: 'b', title: 'Second', agent: 'claude', size: 'light', prompt: 'SECOND', after: ['a'] },
  ] };
  const h = harness(t, { cool: 600, asks: [() => JSON.stringify(plan), () => 'Both finished.'] });
  await h.coord.plan({ text: 'x', recent: [] });
  const run = await h.done();
  assert.deepEqual(run.tasks.map((x) => x.state), ['done', 'done']);
  assert.ok(run.tasks[1].startedAt - run.tasks[0].endedAt >= 550, 'the second task waited for the agent to settle: ' + (run.tasks[1].startedAt - run.tasks[0].endedAt) + ' ms');
  // A turn that ends well but with no answer and an error is not "done": a command Antigravity was refused, for instance.
  const refuser = path.join(os.tmpdir(), `tandem-refuse-${process.pid}.mjs`);
  fs.writeFileSync(refuser, [
    "console.log(JSON.stringify({ event: 'init', conversation_id: 'c1', init: {} }));",
    "console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'Bash' }] } }));",
  ].join('\n'));
  t.after(() => fs.rmSync(refuser, { force: true }));
  const h2 = harness(t, { specsOver: { antigravity: { file: process.execPath, args: [refuser] } }, asks: [() => JSON.stringify({ reply: 'r', tasks: [{ id: 'a', title: 'List files', agent: 'agy', size: 'light', prompt: 'list the files', after: [] }] }), () => 'Report.'] });
  h2.w.add({ id: 'agy', name: 'Agy', provider: 'antigravity' });
  await h2.coord.plan({ text: 'list the files', recent: [] });
  const moved = await h2.done();
  assert.equal(moved.tasks[0].state, 'done', 'it was given to an agent that could do it');
  assert.notEqual(moved.tasks[0].agent, 'agy');
  assert.match(moved.tasks[0].rerouted, /Agy could not do it \(Antigravity was not allowed to run Bash/);
});
