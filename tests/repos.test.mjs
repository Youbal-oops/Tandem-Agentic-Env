import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepoService, normalizeRepoUrl, cloneDestination, runRepoCommand } from '../server/repos.mjs';
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-repos-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('normalizes GitHub shorthand and rejects unsafe and non-repository links', () => {
  assert.equal(normalizeRepoUrl('octocat/Hello-World'), 'https://github.com/octocat/Hello-World.git');
  assert.equal(normalizeRepoUrl('https://github.com/octocat/Hello-World.git/'), 'https://github.com/octocat/Hello-World.git');
  assert.equal(normalizeRepoUrl('https://gitlab.com/group/project.git'), 'https://gitlab.com/group/project.git');
  for (const bad of ['--upload-pack=oops', 'file:///repo', 'git@github.com:owner/repo', 'https://token@github.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?token=secret']) assert.throws(() => normalizeRepoUrl(bad));
});
test('destination must be new with an existing parent; existing files survive', (t) => {
  const root = sandbox(t); const target = path.join(root, 'Repo with spaces');
  assert.equal(cloneDestination(target), target);
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  assert.throws(() => cloneDestination(target), /already exists/);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  assert.throws(() => cloneDestination('relative'), /full path/);
  assert.throws(() => cloneDestination(path.join(root, 'missing', 'repo')));
  assert.throws(() => cloneDestination(path.join(root, 'CON')), /valid new/);
});
test('account list uses authenticated API and returns only picker fields', async () => {
  const calls = [];
  const service = createRepoService({ run: async (file, args) => {
    calls.push({ file, args });
    return args.at(-1) === 'user' ? JSON.stringify({ login: 'alice', secret: 'not-returned' }) : JSON.stringify([{ full_name: 'org/private', private: true, description: 'Team project', extra: 'not-returned' }]);
  } });
  const result = await service.listAccountRepos(2);
  assert.equal(result.login, 'alice'); assert.equal(result.page, 2);
  assert.equal(result.repos[0].url, 'https://github.com/org/private');
  assert.equal(result.repos[0].private, true);
  assert.match(calls[1].args.at(-1), /page=2/);
  assert.match(calls[1].args.at(-1), /collaborator,organization_member/);
  assert.ok(!JSON.stringify(result).includes('not-returned'));
  await assert.rejects(service.listAccountRepos(-1), /Invalid/);
});
for (const source of ['public', 'account']) test(`${source} clone passes separate arguments and verifies its destination`, async (t) => {
  const root = sandbox(t); const destination = path.join(root, 'new project'); const calls = [];
  const service = createRepoService({ run: async (file, args) => {
    calls.push({ file, args });
    if (args.includes('clone')) { fs.mkdirSync(destination); return ''; }
    return destination + '\n';
  } });
  assert.equal(await service.clone({ source, url: 'octocat/Hello-World', destination }), destination);
  assert.equal(calls[0].file, source === 'account' ? 'gh' : 'git');
  assert.ok(calls[0].args.includes('https://github.com/octocat/Hello-World.git'));
  assert.ok(calls[0].args.includes(destination)); assert.ok(calls[0].args.includes('--'));
  assert.deepEqual(calls[1].args, ['-C', destination, 'rev-parse', '--show-toplevel']);
});
test('failed clone keeps partial files and rejects opening it', async (t) => {
  const root = sandbox(t); const destination = path.join(root, 'partial');
  const service = createRepoService({ run: async () => { fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'partial.txt'), 'partial'); throw new Error('Network failed'); } });
  await assert.rejects(service.clone({ source: 'public', url: 'octocat/Hello-World', destination }), /Network failed/);
  assert.equal(fs.readFileSync(path.join(destination, 'partial.txt'), 'utf8'), 'partial');
});
test('process wrapper reports unavailable executables', async () => {
  await assert.rejects(runRepoCommand('tandem-nonexistent-command', ['secret']), /not installed/);
});
