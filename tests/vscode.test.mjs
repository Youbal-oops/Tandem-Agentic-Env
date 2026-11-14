import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVscode, findVscodeCli, folderParam } from '../server/vscode.mjs';

test('a folder becomes the path VS Code web expects', () => {
  assert.equal(folderParam(String.raw`C:\dev\My App`), '/c:/dev/My App');
  assert.equal(folderParam('/home/me/app'), '/home/me/app');
});

test('VS Code is found where its Windows installer puts it, or not at all', () => {
  const file = path.join(String.raw`C:\Users\me\AppData\Local`, 'Programs', 'Microsoft VS Code', 'bin', 'code-tunnel.exe');
  assert.equal(findVscodeCli({ platform: 'win32', env: { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` }, exists: (p) => p === file }), file);
  assert.equal(findVscodeCli({ platform: 'win32', env: { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` }, exists: () => false }), null);
});

test('the editor starts once with a token, serves under /vscode, and is not started when VS Code is missing', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-vscode-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const spawned = [];
  const spawnImpl = (file, args) => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => p.emit('exit', 0);
    spawned.push({ file, args });
    setTimeout(() => p.stdout.emit('data', 'Web UI available at http://127.0.0.1:1234/vscode?tkn=x\n'), 5);
    return p;
  };
  const vs = createVscode({ dataDir, find: () => 'code-cli', spawnImpl, pickPort: async () => 1234 });
  assert.equal(vs.url(String.raw`C:\dev\app`), null, 'no address before it runs');
  const [a, b] = await Promise.all([vs.start(), vs.start()]);
  assert.equal(a, b);
  assert.equal(spawned.length, 1, 'two requests at once start it once');
  const args = spawned[0].args;
  assert.deepEqual(args.slice(0, 5), ['serve-web', '--host', '127.0.0.1', '--port', '1234']);
  assert.ok(args.includes('--accept-server-license-terms') && args.includes(dataDir));
  assert.deepEqual(args.slice(args.indexOf('--server-base-path'), args.indexOf('--server-base-path') + 2), ['--server-base-path', '/vscode']);
  const token = args[args.indexOf('--connection-token') + 1];
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(vs.url(String.raw`C:\dev\app`), `/vscode/?tkn=${token}&folder=/c%3A/dev/app`);
  assert.ok(vs.handles('/vscode/x') && vs.handles('/vscode') && !vs.handles('/vscodex') && !vs.handles('/api/session'));
  // A browser Tandem has marked is passed on with the current token only, whatever old one it still holds; anyone else is left as they were.
  assert.equal(vs.cookies(`vscode-tkn=old; a=1; tandem-vscode=${token}`), `a=1; tandem-vscode=${token}; vscode-tkn=${token}`);
  assert.equal(vs.cookies(`vscode-tkn=old; vscode-tkn=${token}`), `vscode-tkn=${token}`);
  assert.equal(vs.cookies('vscode-tkn=old; tandem-vscode=wrong'), 'vscode-tkn=old; tandem-vscode=wrong');
  vs.stop();
  assert.equal(vs.running(), false);

  await vs.start();
  assert.equal(spawned[1].args[spawned[1].args.indexOf('--connection-token') + 1], token, 'the token is the same on the next start');
  vs.stop();

  const none = createVscode({ dataDir, find: () => null, spawnImpl });
  await assert.rejects(none.start(), /VS Code was not found/);
  assert.equal(spawned.length, 2);
});
