// Isolated Git worktrees for Tandem agents. Work is never auto-merged or deleted.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const clean = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);

export function createWorktrees({ root }) {
  const base = path.join(root, '.tandem', 'worktrees');
  function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  function ensure(repo, id) {
    try {
      const top = git(repo, ['rev-parse', '--show-toplevel']);
      const name = clean(id); const target = path.join(base, path.basename(top), name);
      if (fs.existsSync(target)) return target;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const branch = `tandem/${name}`;
      try { git(top, ['worktree', 'add', target, branch]); }
      catch { git(top, ['worktree', 'add', '-b', branch, target, 'HEAD']); }
      return target;
    } catch {
      return repo; // Non-Git folders still work, but cannot be isolated by Git.
    }
  }
  return { ensure };
}
