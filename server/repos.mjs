import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Never pass a repository URL, folder or account query through a shell.
export function runRepoCommand(file, args, { cwd, progress, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      cwd, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') reject(new Error(`${file} is not installed or is not on PATH.`));
        else if (err.killed) reject(new Error('Repository operation timed out. The partial destination, if any, was kept.'));
        else reject(new Error(file === 'gh' ? 'GitHub operation failed. Check gh auth login, repository access and the network connection.' : 'Clone failed. Check the repository URL, access and network connection. Any partial destination was kept.'));
      } else resolve(stdout);
    });
    child.stdin.end();
    if (progress) child.stderr.on('data', (chunk) => {
      const line = String(chunk).split(/[\r\n]/).filter(Boolean).at(-1);
      if (line) progress(line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 220));
    });
  });
}

export function normalizeRepoUrl(input) {
  if (typeof input !== 'string' || input.length > 2000) throw new Error('Enter a repository HTTPS URL.');
  input = input.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) input = `https://github.com/${input}`;
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a repository HTTPS URL or GitHub owner/repo.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /\s/.test(input)) throw new Error('Use a clean HTTPS repository URL without credentials, query or fragment.');
  if (url.hostname === 'github.com') {
    const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
    if (!match || ['.', '..'].includes(match[1]) || ['.', '..'].includes(match[2])) throw new Error('Use the GitHub repository link, not a branch, file or issue link.');
    url.pathname = `/${match[1]}/${match[2].replace(/\.git$/, '')}.git`;
  }
  if (!url.pathname || url.pathname === '/') throw new Error('The URL must include a repository path.');
  return url.href;
}

export function cloneDestination(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input.trim())) throw new Error('Enter a full path for a new clone folder.');
  const desired = path.resolve(input.trim());
  const name = path.basename(desired);
  if (!name || name === '.' || name === '..' || /[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Choose a valid new folder name.');
  const parent = fs.realpathSync(path.dirname(desired));
  if (!fs.statSync(parent).isDirectory()) throw new Error('The parent folder must already exist.');
  const destination = path.join(parent, name);
  try { fs.lstatSync(destination); throw new Error('That destination already exists. Choose a new folder to avoid overwriting files.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return destination;
}

export function createRepoService({ run = runRepoCommand } = {}) {
  return {
    async listAccountRepos(page = 1) {
      if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('Invalid repository page.');
      const user = JSON.parse(await run('gh', ['api', '--hostname', 'github.com', 'user']));
      const rows = JSON.parse(await run('gh', ['api', '--hostname', 'github.com', `user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`]));
      if (!Array.isArray(rows) || typeof user.login !== 'string') throw new Error('GitHub returned an unexpected response.');
      return { login: user.login, page, hasMore: rows.length === 100, repos: rows.filter((r) => typeof r.full_name === 'string').map((r) => ({
        name: r.full_name, private: !!r.private, description: String(r.description || '').slice(0, 180),
        url: `https://github.com/${r.full_name}`, archived: !!r.archived,
      })) };
    },
    async clone({ url, destination, source }, progress) {
      const remote = normalizeRepoUrl(url);
      if (!['public', 'account'].includes(source)) throw new Error('Choose a public link or your GitHub account.');
      if (source === 'account' && new URL(remote).hostname !== 'github.com') throw new Error('Account cloning currently supports GitHub.com.');
      const target = cloneDestination(destination);
      progress?.('Connecting to repository…');
      if (source === 'account') await run('gh', ['repo', 'clone', '--no-upstream', remote, target, '--', '--progress'], { progress, timeout: 600000 });
      else await run('git', ['clone', '--progress', '--', remote, target], { progress, timeout: 600000 });
      // Do not switch the agents into a failed or incomplete clone.
      const top = String(await run('git', ['-C', target, 'rev-parse', '--show-toplevel'])).trim();
      if (path.resolve(top).toLowerCase() !== target.toLowerCase()) throw new Error('The clone did not produce the expected working repository.');
      return target;
    },
  };
}
