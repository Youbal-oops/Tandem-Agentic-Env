import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { listRepoFiles, readRepoFile, readRepoDiff, writeRepoFile } from '../server/inspect.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-inspect-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, repo };
}
test('file browsing sorts folders first and omits generated directories', (t) => {
  const { repo } = fixture(t);
  for (const d of ['src', '.git', 'node_modules', '.tandem']) fs.mkdirSync(path.join(repo, d));
  fs.writeFileSync(path.join(repo, 'index.html'), '<h1>Hello</h1>');
  assert.deepEqual(listRepoFiles(repo).entries.map((e) => e.name), ['src', 'index.html']);
  assert.equal(readRepoFile(repo, 'index.html').text, '<h1>Hello</h1>');
});
test('preview rejects traversal, external links, binaries and oversized files', (t) => {
  const { root, repo } = fixture(t);
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  assert.throws(() => readRepoFile(repo, '../outside.txt'), /outside/);
  assert.throws(() => readRepoFile(repo, path.join(root, 'outside.txt')), /inside/);
  fs.symlinkSync(root, path.join(repo, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readRepoFile(repo, 'external/outside.txt'), /outside/);
  fs.writeFileSync(path.join(repo, 'binary'), Buffer.from([0, 1, 2]));
  assert.throws(() => readRepoFile(repo, 'binary'), /Binary/);
  fs.writeFileSync(path.join(repo, 'huge'), Buffer.alloc(256 * 1024 + 1, 'a'));
  assert.throws(() => readRepoFile(repo, 'huge'), /256 KB/);
  fs.mkdirSync(path.join(repo, '.git')); fs.writeFileSync(path.join(repo, '.git', 'config'), 'private');
  assert.throws(() => readRepoFile(repo, '.git/config'), /metadata/);
});
test('staged and unstaged diffs use the real git repository', async (t) => {
  const { repo } = fixture(t);
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']); fs.writeFileSync(path.join(repo, 'code.txt'), 'original\n'); git(['add', '--', 'code.txt']);
  git(['-c', 'user.name=Tandem Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=', 'commit', '-m', 'Fixture']);
  fs.writeFileSync(path.join(repo, 'code.txt'), 'staged\n'); git(['add', '--', 'code.txt']);
  fs.writeFileSync(path.join(repo, 'code.txt'), 'working\n');
  assert.match((await readRepoDiff(repo, 'staged')).text, /\+staged/);
  assert.match((await readRepoDiff(repo, 'unstaged')).text, /\+working/);
  assert.match((await readRepoDiff(repo, 'combined')).text, /-original/);
  await assert.rejects(readRepoDiff(repo, 'arbitrary'), /valid diff/);
});

test('the code view saves an existing file, and refuses one that changed on disk or lies outside', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-save-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    const read = readRepoFile(root, 'a.txt');
    const saved = writeRepoFile(root, 'a.txt', 'two', read.mtime);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two');
    assert.equal(saved.bytes, 3);
    assert.throws(() => writeRepoFile(root, 'a.txt', 'three', read.mtime - 5000), /changed on disk/);
    assert.throws(() => writeRepoFile(root, 'new.txt', 'x'), /ENOENT/);
    assert.throws(() => writeRepoFile(root, '../a.txt', 'x'), /outside/);
    assert.throws(() => writeRepoFile(root, 'a.txt', 'x'.repeat(300 * 1024)), /256 KB/);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
