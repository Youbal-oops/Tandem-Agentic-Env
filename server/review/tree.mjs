// Git plumbing for the review window: a snapshot of a working folder as a tree object, and diffs between two
// snapshots. A temporary index is used so nothing in the user's index, branch or worktree is touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const PATCH_LIMIT = 1024 * 1024;

function git(cwd, args, { env = {}, limit = PATCH_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, '--no-pager', ...args], { env: { ...process.env, ...env }, windowsHide: true, maxBuffer: limit, timeout: 20000, encoding: 'utf8' }, (err, out, errText) => {
      if (err) reject(new Error(err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'This change is too large to show as one diff.' : (String(errText).trim() || err.message)));
      else resolve(out);
    });
  });
}

/** The working folder (tracked and untracked files, minus ignored ones) as a git tree id, or null outside a repository. */
export async function snapshotTree(cwd) {
  const index = path.join(os.tmpdir(), `tandem-index-${crypto.randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    try { await git(cwd, ['read-tree', 'HEAD'], { env }); } catch { /* a repository without a commit yet starts from an empty index */ }
    await git(cwd, ['add', '-A', '--', '.'], { env });
    return (await git(cwd, ['write-tree'], { env })).trim();
  } catch {
    return null;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Per-file changed line counts between two tree ids: [{ path, added, removed, binary }]. */
export async function numstat(cwd, from, to) {
  if (!from || !to || from === to) return [];
  const out = await git(cwd, ['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', from, to, '--']);
  return out.split('\n').filter(Boolean).map((line) => {
    const [a, r, ...rest] = line.split('\t');
    const binary = a === '-' || r === '-';
    return { path: rest.join('\t'), added: binary ? 0 : Number(a) || 0, removed: binary ? 0 : Number(r) || 0, binary };
  });
}

/** A unified diff between two tree ids, for one file or for all of them. */
export async function patch(cwd, from, to, file) {
  if (!from || !to || from === to) return '';
  const args = ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '-U4', from, to, '--'];
  if (file) args.push(file);
  return git(cwd, args);
}
