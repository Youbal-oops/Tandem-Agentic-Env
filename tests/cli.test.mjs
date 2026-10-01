import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createAgents } from '../server/agents.mjs';
const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const waitFor = async (check) => {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error('CLI fixture timed out'); await new Promise((r) => setTimeout(r, 20)); }
};
for (const provider of ['claude', 'codex']) test(`${provider} forwards model and effort, then resumes the same thread`, async (t) => {
  const adapter = createAgents({ cwd: process.cwd(), specs: { [provider]: { file: process.execPath, args: [fixture, provider] } }, providers: [provider], broadcast() {} });
  t.after(() => adapter.closeAll());
  adapter.setModel(provider, 'test-model'); adapter.setEffort(provider, 'medium');
  adapter.send(provider, 'First turn');
  await waitFor(() => adapter.snapshot()[provider].meta.turns === 1);
  const first = JSON.parse(adapter.snapshot()[provider].events.find((e) => e.k === 'msg').text);
  assert.ok(first.args.includes('test-model'));
  assert.ok(first.args.includes(provider === 'claude' ? 'medium' : 'model_reasoning_effort="medium"'));
  const thread = adapter.save()[provider].sessionId;
  adapter.setEffort(provider, 'high');
  adapter.send(provider, 'Second turn');
  await waitFor(() => adapter.snapshot()[provider].meta.turns === 2);
  const last = JSON.parse(adapter.snapshot()[provider].events.filter((e) => e.k === 'msg').at(-1).text);
  assert.ok(last.args.includes(provider === 'claude' ? '--resume' : 'resume'));
  assert.ok(last.args.includes(thread));
  assert.ok(last.args.includes(provider === 'claude' ? 'high' : 'model_reasoning_effort="high"'));
  assert.equal(adapter.save()[provider].turnNo, 2);
});
