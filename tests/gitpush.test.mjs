import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claimBranch, pushBranch, pushPreview } from '../server/gitpush.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

test('one tandem branch per main agent worktree, pushed to origin', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-push-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git'), repo = path.join(root, 'My Repo'), second = path.join(root, 'wt2');
  execFileSync('git', ['init', '--bare', remote]);
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'init');
  git(repo, 'worktree', 'add', '-b', 'tandem/agent-codex', second);

  assert.equal(await claimBranch(repo), 'tandem/My-Repo');
  assert.equal(await claimBranch(repo), 'tandem/My-Repo');
  assert.equal(await claimBranch(second), 'tandem/My-Repo-2');

  fs.writeFileSync(path.join(second, 'b.txt'), 'b');
  const result = await pushBranch(repo);
  assert.deepEqual(result, { branch: 'tandem/My-Repo', dirty: 0, committed: 0 });
  assert.match(git(remote, 'branch', '--list'), /tandem\/My-Repo\b/);
  // The second agent's local slot is My-Repo-2, but it still pushes to the one standard branch.
  const again = await pushBranch(second);
  assert.deepEqual(again, { branch: 'tandem/My-Repo', dirty: 1, committed: 0 });
  assert.doesNotMatch(git(remote, 'branch', '--list'), /My-Repo-2/);
});

test('push dialog: preview, choose files and message, edit the branch, never leave tandem/', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-push-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git'), repo = path.join(root, 'proj');
  execFileSync('git', ['init', '--bare', remote]);
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'init');

  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(repo, 'new file.txt'), 'n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1');
  const preview = await pushPreview(repo);
  assert.equal(preview.branch, 'tandem/proj');
  assert.equal(preview.prefix, 'tandem/');
  assert.deepEqual(preview.files.map((f) => f.path).sort(), ['.env', 'a.txt', 'new file.txt']);
  assert.match(preview.head, /init/);

  await assert.rejects(pushBranch(repo, { branch: 'main' }), /must start with tandem\//);
  await assert.rejects(pushBranch(repo, { branch: 'tandem/bad name' }), /not a valid branch/);
  await assert.rejects(pushBranch(repo, { files: ['a.txt'] }), /commit message/);
  await assert.rejects(pushBranch(repo, { files: ['nope.txt'], message: 'x' }), /no changes to commit/);

  const out = await pushBranch(repo, { branch: 'tandem/proj-ui', message: 'Change a and add a file', files: ['a.txt', 'new file.txt'] });
  assert.deepEqual(out, { branch: 'tandem/proj-ui', dirty: 1, committed: 2 });
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'tandem/proj-ui'), 'Change a and add a file');
  assert.equal(git(remote, 'show', 'tandem/proj-ui:a.txt'), 'changed');
  assert.equal(git(remote, 'ls-tree', '-r', '--name-only', 'tandem/proj-ui').includes('.env'), false); // unselected file stayed local
  assert.deepEqual((await pushPreview(repo)).files.map((f) => f.path), ['.env']);
  assert.doesNotMatch(git(remote, 'branch', '--list'), /\bmain\b/);
});
