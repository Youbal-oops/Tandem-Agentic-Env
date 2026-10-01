import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listFolders } from '../server/folders.mjs';

test('folder picker navigates directories and recognizes repositories and worktrees', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tandem-folders-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['project', 'worktree', 'empty', '.git']) await fs.mkdir(path.join(root, name));
  await fs.mkdir(path.join(root, 'project', '.git'));
  await fs.writeFile(path.join(root, 'worktree', '.git'), 'gitdir: ../project/.git');
  await fs.writeFile(path.join(root, 'file.txt'), 'not a folder');
  const listing = await listFolders(root);
  assert.deepEqual(listing.folders.map(f => [f.name, f.repo]), [['empty', false], ['project', true], ['worktree', true]]);
  const nested = await listFolders(listing.folders[1].path);
  assert.equal(nested.parent, listing.path);
  assert.equal(nested.repo, true);
  assert.equal(nested.folders.length, 0);
  assert.ok(listing.roots.includes(path.parse(listing.path).root));
  await assert.rejects(listFolders(path.join(root, 'missing')));
  await assert.rejects(listFolders(path.join(root, 'file.txt')));
});

test('folder picker requires an absolute valid path', async () => {
  for (const invalid of ['../', 'relative', 123, '\0', 'a'.repeat(4097)]) {
    await assert.rejects(listFolders(invalid), /absolute folder path/);
  }
});
