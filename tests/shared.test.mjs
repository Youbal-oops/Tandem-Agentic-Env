import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';
import { cleanTeamChat } from '../server/team-chat.mjs';
import { STARTERS } from './fixtures/starters.mjs';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const specs = Object.fromEntries(['claude', 'codex', 'gemini', 'antigravity'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
const waitFor = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

function open(root, repo) {
  return createWorkspace({ initialAgents: STARTERS, root, cwd: repo, specs, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast() {} });
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-shared-'));
  fs.mkdirSync(path.join(root, 'repo'));
  const repo = fs.realpathSync(path.join(root, 'repo'));
  const other = path.join(root, 'other'); fs.mkdirSync(other);
  const opened = [];
  const w = open(root, repo); opened.push(w);
  t.after(async () => { for (const x of opened) x.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  return { w, root, repo, other: fs.realpathSync(other), reopen: () => { const x = open(root, repo); opened.push(x); return x; } };
}
const echoOf = (w, id) => { const m = w.snapshot()[id].events.filter((e) => e.k === 'msg').at(-1); const j = JSON.parse(m.text.startsWith('Done: ') ? m.text.slice(6) : m.text); return j; };
const ask = async (w, id, text) => {
  const before = w.snapshot()[id].events.filter((e) => e.k === 'turn').length;
  await w.action({ t: 'send', agent: id, text });
  await waitFor(() => !w.snapshot()[id].meta.busy && w.snapshot()[id].events.filter((e) => e.k === 'turn').length > before);
  return echoOf(w, id);
};

test('the Team chat is saved for each repository and survives a restart', (t) => {
  const { w, repo, other, reopen } = setup(t);
  const entry = { id: '1', text: 'what is in this folder?', state: 'done', agent: 'codex', name: 'Codex', result: '# Heading\n\nSome **answer**', tier: 'light', junk: 'dropped', approval: { requestId: 'x' } };
  assert.equal(w.saveTeamChat(repo, [entry]), true);
  assert.equal(w.saveTeamChat(other, [entry]), false, 'a repository that is not open is refused');
  w.closeAll();
  const again = reopen();
  const { cwd, entries } = again.teamChat();
  assert.equal(cwd, repo);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result, '# Heading\n\nSome **answer**');
  assert.ok(!('junk' in entries[0]) && !('approval' in entries[0]), 'only known fields are stored');
  // Another repository has its own chat, and the first one is still there when it is opened again.
  again.switchRepo(other);
  assert.deepEqual(again.teamChat().entries, []);
  again.saveTeamChat(again.cwd, [{ id: '2', text: 'second repo', state: 'done' }]);
  again.switchRepo(repo);
  assert.equal(again.teamChat().entries[0].text, 'what is in this folder?');
});

test('saved Team chats are cleaned and kept small', () => {
  assert.deepEqual(cleanTeamChat('nope'), []);
  assert.deepEqual(cleanTeamChat([{ id: 'a', text: 'ok', state: 'weird', tier: 'huge', at: 5 }, { text: 5 }, null]), [{ id: 'a', text: 'ok', at: 5, state: 'sent' }]);
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, text: `task ${i}`, state: 'done' }));
  assert.equal(cleanTeamChat(many).length, 40);
  assert.equal(cleanTeamChat(many).at(-1).id, 'e59', 'the newest are kept');
  const big = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, text: 't', state: 'done', result: 'x'.repeat(60000) }));
  const kept = cleanTeamChat(big);
  assert.ok(JSON.stringify(kept).length <= 800 * 1024 && kept.at(-1).id === 'b29', 'the oldest go first when it is too large');
});

test('every agent is told about the shared team folder and given access to it', async (t) => {
  const { w, repo } = setup(t);
  const shared = path.join(repo, '.tandem', 'shared');
  w.add({ id: 'gem', name: 'Gem', provider: 'gemini' });
  w.add({ id: 'agy', name: 'Agy', provider: 'antigravity' });
  const claude = await ask(w, 'claude', 'hello');
  assert.ok(fs.existsSync(shared), 'the folder is created');
  assert.match(claude.text, /\[Shared team folder: .*shared\]/);
  assert.match(claude.text, /cannot see the files you create in yours/);
  assert.deepEqual(claude.args.slice(claude.args.indexOf('--add-dir'), claude.args.indexOf('--add-dir') + 2), ['--add-dir', shared]);
  const gem = await ask(w, 'gem', 'hello');
  assert.deepEqual(gem.args.slice(gem.args.indexOf('--include-directories'), gem.args.indexOf('--include-directories') + 2), ['--include-directories', shared]);
  const agy = await ask(w, 'agy', 'hello');
  assert.deepEqual(agy.args.slice(agy.args.indexOf('--add-dir'), agy.args.indexOf('--add-dir') + 2), ['--add-dir', shared]);
  // Codex can only write there when it may write at all.
  const read = await ask(w, 'codex', 'hello');
  assert.ok(!read.args.includes('--add-dir'), 'read-only Codex writes nothing');
  await w.action({ t: 'mode', agent: 'codex', mode: 'edit' });
  const edit = await ask(w, 'codex', 'again');
  assert.deepEqual(edit.args.slice(edit.args.indexOf('--add-dir'), edit.args.indexOf('--add-dir') + 2), ['--add-dir', shared]);
  assert.ok(w.workDirs().some((d) => d.id === 'shared' && d.cwd === shared), 'the shared folder can be browsed and opened in the editors');
});

test('an agent that cannot be restored is kept and reported, not silently dropped', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-unrestored-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  fs.mkdirSync(path.join(root, '.tandem'));
  const saved = { cwd: fs.realpathSync(repo), agents: [
    { config: { id: 'claude', provider: 'claude', name: 'Claude', conversationId: 'c1' }, state: { events: [] } },
    { config: { id: 'broken', provider: 'not-a-provider', name: 'Broken', conversationId: 'c2' }, state: { events: [] } },
  ] };
  fs.writeFileSync(path.join(root, '.tandem', 'workspace.json'), JSON.stringify(saved));
  const w = open(root, repo);
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  assert.deepEqual(w.configs().map((c) => c.id), ['claude']);
  assert.equal(w.startupProblems().length, 1);
  assert.equal(w.startupProblems()[0].name, 'Broken');
  assert.match(w.startupProblems()[0].error, /Choose Claude CLI/);
  w.closeAll();
  const after = JSON.parse(fs.readFileSync(path.join(root, '.tandem', 'workspace.json'), 'utf8'));
  assert.deepEqual(after.agents.map((a) => a.config.id), ['claude', 'broken'], 'the one that failed is still in the saved data');
});
