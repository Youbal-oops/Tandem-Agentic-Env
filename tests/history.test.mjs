import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';

function setup(t, specs = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-history-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const requests = [], workspaces = [];
  const options = { root, cwd: repo, specs, broadcast() {}, fetchImpl: async (_, request) => {
    requests.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Reply' } }] }) };
  } };
  const create = () => { const workspace = createWorkspace(options); workspaces.push(workspace); return workspace; };
  t.after(async () => { for (const workspace of workspaces) workspace.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { w: create(), create, root, repo, requests };
}

test('API history restores messages and settings, preserves the current chat and survives restart', async (t) => {
  const { w, create, repo, requests } = setup(t);
  const agent = w.add({ provider: 'api', model: 'first-model', endpoint: 'http://localhost:1234/v1/chat/completions' });
  const first = agent.conversationId;
  await w.action({ t: 'send', agent: agent.id, text: 'Build the first feature' });
  await w.action({ t: 'newchat', agent: agent.id });
  const second = w.configs().find((row) => row.id === agent.id).conversationId;
  await w.action({ t: 'model', agent: agent.id, model: 'second-model' });
  await w.action({ t: 'send', agent: agent.id, text: 'Another feature' });
  assert.equal(w.chatHistory(agent.id).length, 2);
  w.reopenChat(agent.id, first, repo);
  assert.equal(w.snapshot()[agent.id].meta.model, 'first-model');
  await w.action({ t: 'send', agent: agent.id, text: 'Continue the first feature' });
  assert.deepEqual(requests.at(-1).messages.slice(1).map((row) => row.content), ['Build the first feature', 'Reply', 'Continue the first feature']);
  w.closeAll();
  const restored = create();
  assert.equal(restored.chatHistory(agent.id).length, 2);
  restored.reopenChat(agent.id, second, repo);
  assert.equal(restored.snapshot()[agent.id].meta.model, 'second-model');
  assert.equal(restored.snapshot()[agent.id].events[0].text, 'Another feature');
});

test('history rejects traversal, wrong agents, stale projects and switches during running turns', async (t) => {
  const { w, root, repo } = setup(t);
  const agent = w.add({ provider: 'api', model: 'local', endpoint: 'http://localhost:1234/v1/chat/completions' });
  await w.action({ t: 'newchat', agent: agent.id });
  const old = w.chatHistory(agent.id).find((row) => !row.active).id;
  assert.throws(() => w.reopenChat('codex', old, repo), /different project or agent/);
  assert.throws(() => w.reopenChat(agent.id, '../workspace.json', repo), /Invalid conversation/);
  const pending = w.action({ t: 'send', agent: agent.id, text: 'Work' });
  assert.throws(() => w.reopenChat(agent.id, old, repo), /Stop this agent/);
  await pending;
  const next = path.join(root, 'next'); fs.mkdirSync(next); w.switchRepo(next);
  assert.throws(() => w.reopenChat(agent.id, old, repo), /Repository changed/);
  assert.throws(() => w.reopenChat(agent.id, old, next), /different project or agent/);
  assert.equal(w.chatHistory(agent.id).length, 1);
  w.switchRepo(repo);
  assert.equal(w.chatHistory(agent.id).length, 2);
});

test('CLI history resumes the original thread and restores its subagent chats', async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
  const specs = Object.fromEntries(['claude', 'codex'].map((provider) => [provider, { file: process.execPath, args: [fixture, provider] }]));
  const { w, repo } = setup(t, specs);
  async function waitFor(check) {
    const end = Date.now() + 8000;
    while (!check()) { if (Date.now() > end) throw new Error('Fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  const first = w.configs().find((row) => row.id === 'codex').conversationId;
  w.action({ t: 'send', agent: 'codex', text: 'Original task' });
  await waitFor(() => !w.snapshot().codex.meta.busy);
  const child = w.childAction({ t: 'child-create', agent: 'codex', provider: 'claude', text: 'Review it' });
  await waitFor(() => !w.children()[0].meta.busy);
  w.action({ t: 'newchat', agent: 'codex' });
  assert.equal(w.children().length, 0);
  w.reopenChat('codex', first, repo);
  assert.equal(w.children()[0].id, child.id);
  w.action({ t: 'send', agent: 'codex', text: 'Continue' });
  await waitFor(() => w.snapshot().codex.meta.turns === 2);
  const reply = JSON.parse(w.snapshot().codex.events.filter((event) => event.k === 'msg').at(-1).text);
  assert.ok(reply.args.includes('resume'));
  assert.ok(reply.args.includes('00000000-0000-4000-8000-000000000001'));
});
