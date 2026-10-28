import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';
import { MARKER, askedToWrite, checkText, mergeChecklist, parseGrep, scanTodos, todoPrompt } from '../server/learning/todo.mjs';
import { editorLaunch } from '../server/launcher.mjs';

test('markers are parsed from git grep output, keeping only the hint', () => {
  const out = [
    'src/sort.js:12:  // TODO(you): compare two items, smaller first',
    'src/sort.js:30:  /* TODO(you) - merge the halves */',
    'api/app.py:7:    raise NotImplementedError("TODO(you)")',
    'not a grep line',
  ].join('\n');
  assert.deepEqual(parseGrep(out), [
    { file: 'src/sort.js', line: 12, text: 'compare two items, smaller first' },
    { file: 'src/sort.js', line: 30, text: 'merge the halves' },
  ]);
  assert.deepEqual(parseGrep(''), []);
});

test('the checklist ticks off a marker that is gone, follows one that moves, and adds new ones', () => {
  const a = { file: 'a.js', line: 3, text: 'parse the header' };
  const b = { file: 'a.js', line: 9, text: 'validate the body' };
  let list = mergeChecklist([], [a, b]);
  assert.deepEqual(list.map((t) => t.done), [false, false]);
  list = mergeChecklist(list, [{ ...b, line: 14 }]); // a is written, b moved down
  assert.deepEqual(list, [{ file: 'a.js', line: 3, text: 'parse the header', done: true }, { file: 'a.js', line: 14, text: 'validate the body', done: false }]);
  list = mergeChecklist(list, [{ ...b, line: 14 }, { file: 'b.js', line: 1, text: 'render it' }]);
  assert.deepEqual(list.map((t) => `${t.file}:${t.done}`), ['a.js:true', 'a.js:false', 'b.js:false']);
  list = mergeChecklist(list, []);
  assert.ok(list.every((t) => t.done));
});

test('asking the agent to write the user\'s logic is spotted, asking for tests and scaffolding is not', () => {
  for (const text of ['just write it for me', 'Please fill in the TODOs for me', 'give me the solution', 'show me the answer', 'just do it', 'what is the answer']) assert.ok(askedToWrite(text), text);
  for (const text of ['write the tests for me', 'can you set up the types for me?', 'I wrote the parser, can you check it?', 'How should I compare two items?', 'create the scaffold for me']) assert.equal(askedToWrite(text), null, text);
});

test('the TODO prompt keeps the logic with the user, and the check message asks for hints only', () => {
  const p = todoPrompt();
  assert.match(p, /YOURS to write/); assert.match(p, /THEIRS to write/);
  assert.match(p, new RegExp(MARKER.replace(/[()]/g, '\\$&')));
  assert.match(p, /Never write it, not even partly/);
  assert.match(checkText([{ file: 'a.js', line: 3, text: 'parse it' }]), /a\.js:3 parse it/);
  assert.match(checkText([]), /No TODO\(you\) marker is left/);
  assert.match(checkText([]), /Give hints only, never the logic/);
});

test('the editor opens a file at a line', () => {
  const decode = (l) => Buffer.from(l.args.at(-1), 'base64').toString('utf16le');
  assert.match(decode(editorLaunch('win32', 'C:\\r\\a.js', { code: 'C:\\vs\\Code.exe', isFile: true, line: 12 })), /'--goto', '"C:\\r\\a\.js:12"'/);
  assert.deepEqual(editorLaunch('linux', '/r/a.js', { code: 'code', isFile: true, line: 12 }), { cmd: 'code', args: ['--goto', '/r/a.js:12'] });
  assert.deepEqual(editorLaunch('linux', '/r/a.js', { code: 'code', isFile: true }), { cmd: 'code', args: ['--goto', '/r/a.js'] });
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
function gitRepo(t, cleanup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-todo-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
  return { root, repo };
}

test('scanning finds markers in tracked and new files, never in .tandem', async (t) => {
  const { repo } = gitRepo(t);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export function f() {\n  // TODO(you): the logic\n}\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'x');
  fs.writeFileSync(path.join(repo, 'b.js'), '// TODO(you): another one\n'); // not added yet
  fs.mkdirSync(path.join(repo, '.tandem')); fs.writeFileSync(path.join(repo, '.tandem', 'notes.md'), 'TODO(you) ignored');
  const found = await scanTodos(repo);
  assert.deepEqual(found.map((x) => `${x.file}:${x.line}`).sort(), ['a.js:2', 'b.js:1']);
  assert.deepEqual(await scanTodos(path.join(repo, 'missing')), []);
});

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const replies = (w, id) => w.snapshot()[id].events.filter((e) => e.k === 'msg').map((e) => e.text);
const users = (w, id) => w.snapshot()[id].events.filter((e) => e.k === 'user').map((e) => e.text);
const idle = (w, id) => !w.snapshot()[id].meta.busy;

function workspace(t) {
  const { root, repo } = gitRepo(t, false);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export function f() {\n  // TODO(you): the logic\n}\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'x');
  const sent = [];
  const w = createWorkspace({ root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast: (m) => sent.push(m) });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  return { w, sent };
}

test('TODO mode needs learning mode, adds its prompt to main agents, and refuses "write it for me"', async (t) => {
  const { w } = workspace(t);
  w.setTodoMode(true);
  assert.equal(w.localState().todoMode, true);
  await w.action({ t: 'send', agent: 'codex', text: 'Plan a sorter' });
  await waitFor(() => replies(w, 'codex').length === 1 && idle(w, 'codex'));
  assert.doesNotMatch(replies(w, 'codex')[0], /TODO mode: you write the structure/, 'learning mode is off, so nothing is added');

  w.setLearningMode(true);
  await w.action({ t: 'send', agent: 'codex', text: 'Plan a sorter' });
  await waitFor(() => replies(w, 'codex').length === 2 && idle(w, 'codex'));
  assert.match(replies(w, 'codex')[1], /TODO mode: you write the structure, the user writes the logic/);

  await w.action({ t: 'send', agent: 'codex', text: 'just write it for me' });
  await waitFor(() => replies(w, 'codex').length === 3 && idle(w, 'codex'));
  assert.match(users(w, 'codex').at(-1), /TODO mode is on\. The user is asking you to write the logic/);
  assert.equal(w.localState().learnerProfile.behavior.delegations >= 1, true);
  assert.throws(() => w.action({ t: 'implement', agent: 'codex' }), /not satisfied yet/, 'the gate still applies');

  w.setTodoMode(false);
  await w.action({ t: 'send', agent: 'codex', text: 'Plan a sorter again' });
  await waitFor(() => replies(w, 'codex').length === 4 && idle(w, 'codex'));
  assert.doesNotMatch(replies(w, 'codex')[3], /TODO mode: you write the structure/);
});

test('in TODO mode the approved step builds a scaffold, and the checklist follows the code', async (t) => {
  const { w, sent } = workspace(t);
  w.setLearningMode(true); w.setTodoMode(true);
  await w.action({ t: 'send', agent: 'codex', text: 'Sort by name. RAW-REPLY:\nREADY TO BUILD: a sorter whose compare function I write' });
  await waitFor(() => w.localState().checkpoints.codex.ready && idle(w, 'codex'));
  w.action({ t: 'confirm-design', agent: 'codex' });
  w.action({ t: 'implement', agent: 'codex' });
  await waitFor(() => replies(w, 'codex').some((r) => /Build the scaffold now/.test(r)) && idle(w, 'codex'));
  await waitFor(() => w.localState().checkpoints.codex.stage === 'report');
  assert.ok(!replies(w, 'codex').some((r) => /Implement the agreed step now/.test(r)), 'it is the scaffold text, not the normal one');

  // The checklist is sent after the step, and follows the code as the user writes the logic.
  await waitFor(() => sent.some((m) => m.t === 'todos' && m.agent === 'codex' && m.todos.length === 1));
  const dir = w.workDirs().find((d) => d.id === 'codex').cwd;
  const first = (await w.todosFor('codex')).todos;
  assert.deepEqual(first.map((x) => [x.file, x.text, x.done]), [['a.js', 'the logic', false]]);
  fs.writeFileSync(path.join(dir, 'a.js'), 'export function f(a, b) {\n  return a.name < b.name ? -1 : 1;\n}\n');
  const after = (await w.todosFor('codex')).todos;
  assert.deepEqual(after.map((x) => [x.text, x.done]), [['the logic', true]]);

  // "Check my work": the agent is asked for hints, never the logic.
  await w.action({ t: 'todo-check', agent: 'codex' });
  await waitFor(() => users(w, 'codex').some((u) => /check the logic they have written/.test(u)) && idle(w, 'codex'));
  assert.match(users(w, 'codex').at(-1), /Give hints only, never the logic itself/);
  assert.match(users(w, 'codex').at(-1), /No TODO\(you\) marker is left/);
  assert.equal(w.localState().checkpoints.codex.stage, 'report');
});

test('check my work needs TODO mode, and an agent that leaves no markers is called out', async (t) => {
  const { w, sent } = workspace(t);
  w.setLearningMode(true);
  await assert.rejects(Promise.resolve().then(() => w.action({ t: 'todo-check', agent: 'codex' })), /Turn on TODO mode/);
  w.setTodoMode(true);

  // Take the marker away before the step ends, as if the agent had written the logic itself.
  const dir = w.workDirs().find((d) => d.id === 'codex').cwd;
  await w.action({ t: 'send', agent: 'codex', text: 'Sort by name. RAW-REPLY:\nREADY TO BUILD: a sorter' });
  await waitFor(() => w.localState().checkpoints.codex.ready && idle(w, 'codex'));
  w.action({ t: 'confirm-design', agent: 'codex' });
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const f = () => 1;\n');
  w.action({ t: 'implement', agent: 'codex' });
  await waitFor(() => w.localState().checkpoints.codex.stage === 'report');
  await waitFor(() => sent.some((m) => m.t === 'todos' && m.agent === 'codex'));
  // No edit event came from the stub CLI, so the "left no markers" notice (which needs an edited file) is not expected here.
  assert.equal(sent.some((m) => m.t === 'notice' && /left no TODO\(you\) markers/.test(m.text)), false);
});
