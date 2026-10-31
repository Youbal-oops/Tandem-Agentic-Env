import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspace } from '../server/workspace.mjs';
import { findConnections } from '../server/app/connections.mjs';
import { API_SERVICES, PLANET_RINGS, PLANET_STYLES } from '../server/app/services.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-test-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const w = createWorkspace({ initialAgents: [{ id: 'claude', name: 'Claude', provider: 'claude' }, { id: 'codex', name: 'Codex', provider: 'codex' }], root, cwd: repo, specs: { claude: null, codex: null }, broadcast() {} });
  t.after(() => { w.closeAll(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  return { w, root, repo };
}
const models = (ids) => async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) });
const gemini = { key: 'cli:gemini', provider: 'gemini', name: 'Gemini' };
const openrouter = { key: 'api:openrouter', provider: 'api', service: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY', model: 'openai/gpt-4o' };

test('a workspace starts with no planets, and names default to the connection and stay unique', (t) => {
  const { root, repo } = setup(t);
  const empty = createWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-empty-')), cwd: repo, specs: {}, broadcast() {} });
  t.after(() => empty.closeAll());
  assert.deepEqual(empty.configs(), []);
  assert.equal(empty.add({ provider: 'claude' }).name, 'Claude');
  assert.equal(empty.add({ provider: 'claude' }).name, 'Claude 2');
  assert.equal(empty.add({ provider: 'claude', name: 'Reviewer' }).name, 'Reviewer');
  assert.equal(empty.add({ provider: 'api', service: 'openrouter', model: 'm', endpoint: 'http://localhost:1234' }).name, 'OpenRouter');
  for (const c of empty.configs()) empty.remove(c.id); // the last planet can be removed too
  assert.deepEqual(empty.configs(), []);
  void root;
});

test('planets saved by older versions keep their own looks; every new planet gets a random saved style', (t) => {
  const { w, root, repo } = setup(t);
  assert.ok(w.configs().every((c) => Number.isInteger(c.style)), 'planets made now always get a style');
  // A planet saved by an older version has the original id and no style: it is restored with its fixed look.
  const old = createWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-legacy-')), cwd: repo, specs: {}, broadcast() {} });
  t.after(() => old.closeAll());
  assert.equal(old.add({ id: 'claude', provider: 'claude', name: 'Claude' }, { events: [] }).style, undefined);
  void root;
  const seen = new Set(), rings = new Set();
  for (let i = 0; i < 40; i++) {
    const c = w.add({ provider: 'api', model: 'm', endpoint: 'http://localhost:1234', id: `p${i}` });
    assert.ok(Number.isInteger(c.style) && c.style >= 0 && c.style < PLANET_STYLES);
    assert.ok(Number.isInteger(c.ring) && c.ring >= 0 && c.ring < PLANET_RINGS);
    seen.add(c.style); rings.add(c.ring);
    w.remove(c.id);
  }
  assert.ok(seen.size > 1, 'styles vary');
  assert.ok(rings.size > 2 && rings.has(0), 'ring looks vary, and some planets have none');
  assert.equal(w.add({ provider: 'api', model: 'm', endpoint: 'http://localhost:1234', id: 'old', ring: true }).ring, 1);
});

test('a new connection gets one planet, once, and a removed planet does not come back', (t) => {
  const { w } = setup(t);
  assert.deepEqual(w.autoConnect([gemini, openrouter]), ['Gemini', 'OpenRouter']);
  const added = w.configs().filter((c) => ['gemini', 'openrouter'].includes(c.id));
  assert.equal(added.length, 2);
  assert.equal(added.find((c) => c.id === 'openrouter').service, 'openrouter');
  assert.equal(added.find((c) => c.id === 'openrouter').model, 'openai/gpt-4o');
  assert.deepEqual(w.autoConnect([gemini, openrouter]), []);
  w.remove('gemini');
  assert.deepEqual(w.autoConnect([gemini]), []);
  assert.equal(w.configs().some((c) => c.provider === 'gemini'), false);
});

test('connections already in use at startup are not added again, and seen kinds survive a restart', (t) => {
  const { w, root, repo } = setup(t);
  assert.deepEqual(w.autoConnect([{ key: 'cli:claude', provider: 'claude', name: 'Claude' }, { key: 'cli:codex', provider: 'codex', name: 'Codex' }]), []);
  w.autoConnect([openrouter]); w.remove('openrouter'); w.closeAll();
  const again = createWorkspace({ root, cwd: repo, specs: {}, broadcast() {} });
  t.after(() => again.closeAll());
  assert.deepEqual(again.autoConnect([openrouter]), []);
});

test('the number of planets stays at eight', (t) => {
  const { w } = setup(t);
  const many = Array.from({ length: 10 }, (_, i) => ({ ...openrouter, key: `api:x${i}`, service: `x${i}`, name: `X${i}` }));
  w.autoConnect(many);
  assert.equal(w.configs().length, 8);
});

test('scan finds signed-in CLIs, API services with a key set, and running local servers', async () => {
  const found = await findConnections({
    cliStatus: [{ id: 'gemini', name: 'Gemini CLI', installed: true, signedIn: true }, { id: 'claude', name: 'Claude Code', installed: true, signedIn: false }, { id: 'codex', name: 'Codex CLI', installed: false, signedIn: null }],
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl: async (url) => (String(url).includes('11434') ? { ok: false, status: 500 } : models(['first', 'second'])()),
  });
  assert.deepEqual(found.map((c) => c.key).sort(), ['api:lmstudio', 'api:openrouter', 'cli:gemini']);
  assert.equal(found.find((c) => c.key === 'cli:gemini').name, 'Gemini');
  assert.equal(found.find((c) => c.key === 'api:openrouter').model, 'first');
});

test('every built-in service endpoint is valid for a planet', () => {
  for (const s of API_SERVICES) {
    const url = new URL(s.endpoint);
    assert.ok(url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname), s.id);
    assert.match(s.keyEnv, /^([A-Z][A-Z0-9_]*)?$/, s.id);
  }
});
