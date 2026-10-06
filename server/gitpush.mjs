import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (cwd, args, trim = true) => new Promise((resolve, reject) =>
  execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) =>
    err ? reject(new Error(String(errOut || err.message).trim())) : resolve(trim ? String(out).trim() : String(out))));
const git = (cwd, args) => run(cwd, args);

const safe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'repo';
const PREFIX = 'tandem/';

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

/** Changed files in a worktree as `{ path, status }`, parsed from NUL-separated porcelain output. */
export async function changedFiles(cwd) {
  const parts = (await run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], false)).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2), file = parts[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next entry is the rename source
    files.push({ path: file, status: code.trim() || '?' });
  }
  return files;
}

/** What a push from this worktree would do, for the dialog: default branch, changed files, last commit. */
export async function pushPreview(cwd) {
  const quiet = (args) => git(cwd, args).catch(() => '');
  const [repo, files, head, current] = await Promise.all([repoName(cwd), changedFiles(cwd), quiet(['log', '-1', '--format=%h %s']), quiet(['rev-parse', '--abbrev-ref', 'HEAD'])]);
  return { repo, branch: `${PREFIX}${repo}`, prefix: PREFIX, current, head, files };
}

/** Remote branches must live under tandem/ and be valid git refs; main and friends are never reachable from here. */
async function checkBranch(cwd, branch) {
  if (typeof branch !== 'string' || !branch.startsWith(PREFIX) || branch.length === PREFIX.length) throw new Error(`The branch name must start with ${PREFIX}`);
  try { await git(cwd, ['check-ref-format', `refs/heads/${branch}`]); } catch { throw new Error(`"${branch}" is not a valid branch name.`); }
  return branch;
}

/**
 * Push this worktree's HEAD to origin's `tandem/<repo>` branch (or another `tandem/...` branch you name).
 * Every main agent pushes to that same branch by default, whatever its local `-2` slot is called
 * (git needs unique local branch names, the remote does not). Optionally commits the chosen files first.
 * Never forced: if another agent pushed first, git rejects it and the user merges before pushing again.
 */
export async function pushBranch(cwd, { branch, message, files } = {}) {
  branch = await checkBranch(cwd, branch || `${PREFIX}${await repoName(cwd)}`);
  try { await git(cwd, ['rev-parse', '--verify', 'HEAD']); } catch { throw new Error('Nothing to push yet: this repository has no commits.'); }
  let committed = 0;
  if (Array.isArray(files) && files.length) {
    const known = new Set((await changedFiles(cwd)).map((f) => f.path));
    const picked = [...new Set(files)];
    for (const f of picked) if (typeof f !== 'string' || !known.has(f)) throw new Error(`"${f}" has no changes to commit.`);
    if (typeof message !== 'string' || !message.trim()) throw new Error('Write a commit message for the files you selected.');
    if (message.length > 5000) throw new Error('The commit message is too long.');
    await git(cwd, ['add', '--', ...picked]);
    await git(cwd, ['commit', '-m', message.trim(), '--', ...picked]); // --: only these paths, not whatever else is staged
    committed = picked.length;
  }
  const dirty = (await changedFiles(cwd)).length;
  await git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  return { branch, dirty, committed };
}
