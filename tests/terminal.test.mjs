import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTerminal } from '../server/terminal.mjs';

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-term-')));
  fs.mkdirSync(path.join(root, 'sub dir'));
  const log = [];
  const term = createTerminal({ cwd: root, emit: (m) => log.push(m) });
  t.after(async () => { term.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  const text = () => log.filter((m) => m.kind === 'out').map((m) => m.text).join('');
  const dones = () => log.filter((m) => m.kind === 'done').length;
  const waitFor = async (check) => { const end = Date.now() + 15000; while (!check()) { if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(log)}`); await new Promise((r) => setTimeout(r, 25)); } };
  return { root, log, term, text, dones, waitFor };
}

test('runs a command in the terminal folder and reports when it is done', async (t) => {
  const { term, text, dones, waitFor, log } = setup(t);
  term.run('node -e "console.log(\'hi-\' + (40 + 2))"');
  assert.equal(term.state().running, true);
  await waitFor(() => dones() === 1);
  assert.match(text(), /hi-42/);
  assert.equal(log.at(-1).code, 0);
  assert.equal(term.state().running, false);
  term.run('node -e "process.exit(3)"');
  await waitFor(() => dones() === 2);
  assert.equal(log.at(-1).code, 3); // the program's own exit code, not a generic 1
});

test('cd sticks between commands and a missing folder changes nothing', async (t) => {
  const { root, term, text, dones, waitFor, log } = setup(t);
  term.run('cd "sub dir"');
  assert.equal(term.state().cwd, path.join(root, 'sub dir'));
  term.run('node -e "console.log(process.cwd())"');
  await waitFor(() => dones() === 2);
  assert.ok(text().includes(path.join(root, 'sub dir')), text());
  term.run('cd nowhere');
  assert.equal(term.state().cwd, path.join(root, 'sub dir'));
  assert.ok(log.some((m) => m.kind === 'err' && /no such folder/.test(m.text)));
  term.run('cd ..');
  assert.equal(term.state().cwd, root);
});

test('lines typed while a command runs go to its stdin, and interrupt stops it', async (t) => {
  const { term, text, dones, waitFor } = setup(t);
  term.run('node -e "process.stdin.on(\'data\', d => { console.log(\'got \' + d.toString().trim()); process.exit(0); })"');
  term.run('hello');
  await waitFor(() => dones() === 1);
  assert.match(text(), /got hello/);

  term.run('node -e "setInterval(() => {}, 1000)"');
  assert.equal(term.state().running, true);
  term.interrupt();
  await waitFor(() => dones() === 2);
  assert.equal(term.state().running, false);
});

test('Tandem private settings are not handed to terminal commands', async (t) => {
  process.env.TANDEM_JOB_TOKEN = 'secret-token';
  t.after(() => { delete process.env.TANDEM_JOB_TOKEN; });
  const { term, text, dones, waitFor } = setup(t);
  term.run('node -e "console.log(process.env.TANDEM_JOB_TOKEN || \'none\')"');
  await waitFor(() => dones() === 1);
  assert.match(text(), /none/);
  assert.doesNotMatch(text(), /secret-token/);
});

test('long lines are refused and a closed terminal stays silent', async (t) => {
  const { term, log } = setup(t);
  term.run('x'.repeat(9000));
  assert.ok(log.some((m) => m.kind === 'err' && /longer than/.test(m.text)));
  term.close();
  const before = log.length;
  term.run('node -e "1"');
  assert.equal(log.length, before);
});
