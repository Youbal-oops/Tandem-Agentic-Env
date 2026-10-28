import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { choosePort, portFree } = createRequire(import.meta.url)('../desktop/port.cjs');
const APP = fileURLToPath(new URL('..', import.meta.url));
const listen = (port = 0) => new Promise((resolve) => { const s = net.createServer().listen(port, '127.0.0.1', () => resolve(s)); });
const close = (s) => new Promise((r) => s.close(r));

test('a free port is used as asked', async () => {
  const holder = await listen();
  const { port } = holder.address();
  await close(holder);
  assert.equal(await portFree(port), true);
  assert.equal(await choosePort(port), port);
});

test('a busy port is never a reason not to start: another free one is chosen', async () => {
  const holder = await listen();
  const { port } = holder.address();
  try {
    assert.equal(await portFree(port), false);
    const chosen = await choosePort(port);
    assert.notEqual(chosen, port);
    assert.equal(await portFree(chosen), true);
  } finally { await close(holder); }
});

test('the standalone server explains a busy port instead of printing a stack trace', async () => {
  const holder = await listen();
  const { port } = holder.address();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-port-'));
  try {
    const child = spawn(process.execPath, ['server/index.mjs'], { cwd: APP, windowsHide: true, env: { ...process.env, TANDEM_PORT: String(port), TANDEM_APP_ROOT: APP, TANDEM_DATA_ROOT: data } });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(err, /already in use/);
    assert.match(err, /TANDEM_PORT/);
    assert.doesNotMatch(err, /at Server\.setupListenHandle/);
  } finally {
    await close(holder);
    await fs.promises.rm(data, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
