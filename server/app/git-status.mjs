// Git state of the open repository, shown on the "sun" and in the right-hand panel. Re-read every few seconds.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function createGitStatus({ getCwd, broadcast, intervalMs = 3000 }) {
  const empty = () => ({ cwd: getCwd(), repo: path.basename(getCwd()), branch: '', ahead: 0, behind: 0, changed: 0, files: [], commits: [], pkg: null });
  let git = empty();
  const run = (args, cwd) =>
    new Promise((resolve) =>
      execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out))),
    );

  async function refresh() {
    const readingDir = getCwd();
    const gitRun = (args) => run(args, readingDir);
    const branch = await gitRun(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === null) return;
    const [status, numstat, log, counts] = await Promise.all([
      gitRun(['status', '--porcelain=v1', '-uall']),
      gitRun(['diff', '--numstat', 'HEAD']),
      gitRun(['log', '-6', '--pretty=format:%h%x09%an%x09%ar%x09%s']),
      gitRun(['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    ]);
    const stat = new Map();
    for (const l of (numstat || '').split('\n').filter(Boolean)) {
      const [add, del, ...p] = l.split('\t');
      stat.set(p.join('\t'), { add: Number(add) || 0, del: Number(del) || 0 });
    }
    const files = (status || '')
      .split('\n')
      .filter(Boolean)
      .slice(0, 60)
      .map((l) => {
        const code = l.slice(0, 2).trim() || 'M';
        const p = l.slice(3).replace(/^"|"$/g, '');
        return { s: code === '??' ? 'U' : code[0], p, ...(stat.get(p) || { add: 0, del: 0 }) };
      });
    const [behind, ahead] = (counts || '0\t0').trim().split(/\s+/).map(Number);
    let pkg = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(readingDir, 'package.json'), 'utf8'));
      pkg = { name: j.name, version: j.version, scripts: Object.keys(j.scripts || {}).slice(0, 8) };
    } catch {
      /* no package.json here */
    }
    const next = {
      cwd: readingDir,
      repo: path.basename(readingDir),
      branch: branch.trim(),
      ahead: ahead || 0,
      behind: behind || 0,
      changed: (status || '').split('\n').filter(Boolean).length,
      files,
      commits: (log || '').split('\n').filter(Boolean).map((l) => {
        const [h, a, t, ...s] = l.split('\t');
        return { h, a, t, s: s.join('\t') };
      }),
      pkg,
    };
    if (readingDir === getCwd() && JSON.stringify(next) !== JSON.stringify(git)) {
      git = next;
      broadcast({ t: 'git', git });
    }
  }

  return {
    get current() { return git; },
    /** Forget the old repository's state (call after switching repositories, then `refresh`). */
    reset() { git = empty(); },
    refresh,
    start() { refresh(); setInterval(refresh, intervalMs).unref(); },
  };
}
