import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (cwd, args) => new Promise((resolve, reject) =>
  execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) =>
    err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim())));

const safe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'repo';

/** Name of the repository, taken from the shared .git directory so every worktree agrees on it. */
export async function repoName(cwd) {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return safe(path.basename(path.dirname(common)));
}

/**
 * One branch per main agent session: `tandem/<repo>` for the first worktree,
 * `tandem/<repo>-2` for the second and so on. Subagents share their main agent's worktree,
 * so their work already lives on that branch. Slots are kept in the shared git dir.
 */
export function claimBranchSync(cwd, worktree) {
  const run = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const common = run('rev-parse', '--path-format=absolute', '--git-common-dir');
  const top = path.resolve(worktree || run('rev-parse', '--show-toplevel'));
  const base = `tandem/${safe(path.basename(path.dirname(common)))}`;
  const file = path.join(common, 'tandem-branches.json');
  let slots = {};
  try { slots = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  for (const dir of Object.keys(slots)) if (dir !== top && !fs.existsSync(dir)) delete slots[dir];
  if (!slots[top]) {
    const taken = new Set(Object.values(slots));
    let name = base, n = 1;
    while (taken.has(name)) name = `${base}-${++n}`;
    slots[top] = name;
  }
  fs.writeFileSync(file, JSON.stringify(slots, null, 2));
  return slots[top];
}

export const claimBranch = async (cwd) => claimBranchSync(cwd);

/** Push this worktree's HEAD to its tandem branch on origin. */
export async function pushBranch(cwd) {
  const branch = await claimBranch(cwd);
  const dirty = (await git(cwd, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
  try { await git(cwd, ['rev-parse', '--verify', 'HEAD']); } catch { throw new Error('Nothing to push yet: this repository has no commits.'); }
  await git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  return { branch, dirty };
}
