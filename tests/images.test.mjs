import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageStore, MAX_IMAGE_BYTES } from '../server/images.mjs';
import { createAgents } from '../server/agents.mjs';
import { createWorkspace } from '../server/workspace.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-images-'));
  const closers = [];
  t.after(() => { for (const close of closers) close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = createImageStore(root);
  const attachment = { ...store.save(png), name: 'Screenshot.png' };
  return { root, store, attachment, onClose: close => closers.push(close) };
}
async function waitFor(check) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error('CLI fixture timed out'); await new Promise(r => setTimeout(r, 20)); }
}
test('image storage validates type, limits and IDs and persists across restart', t => {
  const { root, store, attachment } = setup(t);
  assert.deepEqual(createImageStore(root).read(attachment.id).data, png);
  assert.throws(() => store.save(Buffer.from('<svg></svg>')), /PNG/);
  assert.throws(() => store.save(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /10 MB/);
  assert.throws(() => store.read('../workspace.json'), /Invalid/);
  assert.throws(() => store.resolve(Array(5).fill(attachment)), /four/);
  assert.throws(() => store.resolve([{ id: 'missing', path: 'C:/secret.png' }]), /Invalid/);
  const resolved = store.resolve([{ ...attachment, path: 'C:/secret.png', url: 'https://example.com', mime: 'text/html' }])[0];
  assert.equal(resolved.path, path.join(root, '.tandem', 'uploads', attachment.id));
  assert.equal(resolved.mime, 'image/png');
});
for (const provider of ['claude', 'codex']) test(`${provider} receives images on initial and resumed turns`, async t => {
  const { root, store, attachment, onClose } = setup(t);
  const adapter = createAgents({ cwd: process.cwd(), specs: { [provider]: { file: process.execPath, args: [fixture, provider] } }, providers: [provider], broadcast() {} });
  onClose(() => adapter.closeAll());
  for (let turn = 1; turn <= 2; turn++) {
    adapter.send(provider, turn === 1 ? 'Review this' : '', store.resolve([attachment]));
    await waitFor(() => adapter.snapshot()[provider].meta.turns === turn);
    const events = adapter.snapshot()[provider].events;
    const reply = JSON.parse(events.filter(e => e.k === 'msg').at(-1).text);
    if (provider === 'codex') {
      const imageFlag = reply.args.indexOf('--image');
      assert.equal(reply.args[imageFlag + 1], store.read(attachment.id).path);
      if (turn === 2) assert.ok(imageFlag > reply.args.indexOf('resume'));
    } else {
      assert.equal(reply.text[0].type, 'text');
      assert.equal(reply.text[1].source.media_type, 'image/png');
      assert.equal(reply.text[1].source.data, png.toString('base64'));
    }
    assert.equal(events.filter(e => e.k === 'user').at(-1).attachments[0].name, 'Screenshot.png');
    assert.equal(events.filter(e => e.k === 'user').at(-1).attachments[0].data, undefined);
  }
});
test('API images survive history and restart without storing base64 in conversations', async t => {
  const { root, attachment, onClose } = setup(t);
  const requests = [];
  const fetchImpl = async (_, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Reviewed' } }] }) };
  };
  let workspace = createWorkspace({ root, cwd: root, specs: {}, broadcast() {}, fetchImpl });
  onClose(() => workspace.closeAll());
  const agent = workspace.add({ provider: 'api', model: 'vision', endpoint: 'http://localhost:1234' });
  await workspace.action({ t: 'send', agent: agent.id, text: '', attachments: [attachment] });
  assert.equal(requests[0].messages[1].content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  workspace.closeAll();
  assert.equal(fs.readFileSync(path.join(root, '.tandem', 'workspace.json'), 'utf8').includes(png.toString('base64')), false);
  workspace = createWorkspace({ root, cwd: root, specs: {}, broadcast() {}, fetchImpl });
  await workspace.action({ t: 'send', agent: agent.id, text: 'Look again' });
  assert.equal(requests[1].messages[1].content[1].image_url.url, requests[0].messages[1].content[1].image_url.url);
  assert.equal(requests[1].messages.at(-1).content, 'Look again');
  assert.throws(() => workspace.action({ t: 'send', agent: agent.id, text: 'bad', attachments: [{ id: '../secret' }] }), /Invalid/);
});
test('child follow-ups forward images to their independent CLI thread', async t => {
  const { root, attachment, onClose } = setup(t);
  const workspace = createWorkspace({ root, cwd: process.cwd(), specs: { codex: { file: process.execPath, args: [fixture, 'codex'] } }, broadcast() {} });
  onClose(() => workspace.closeAll());
  const child = workspace.childAction({ t: 'child-create', agent: 'codex', provider: 'codex', text: 'Review' });
  await waitFor(() => !workspace.children()[0].meta.busy);
  workspace.childAction({ t: 'child-action', id: child.id, action: 'send', text: '', attachments: [attachment] });
  await waitFor(() => workspace.children()[0].events.filter(e => e.k === 'msg').length === 2);
  const reply = JSON.parse(workspace.children()[0].events.filter(e => e.k === 'msg').at(-1).text);
  assert.ok(reply.args.includes('--image'));
  assert.equal(workspace.snapshot().codex.events.length, 0);
});
