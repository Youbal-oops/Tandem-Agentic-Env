import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claimBranch, pushBranch } from '../server/gitpush.mjs';

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
  assert.deepEqual(result, { branch: 'tandem/My-Repo', dirty: 0 });
  assert.match(git(remote, 'branch', '--list'), /tandem\/My-Repo\b/);
  assert.equal((await pushBranch(second)).dirty, 1);
});
