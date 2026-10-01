import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const LIMIT = 256 * 1024;
const hidden = new Set(['.git', '.tandem', 'node_modules', '.venv', 'dist']);
export function repoPath(root, relative = '') {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Choose a path inside the repository.');
  const base = fs.realpathSync(root);
  const requested = path.resolve(base, relative);
  const inside = (p) => { const r = path.relative(base, p); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
  if (!inside(requested)) throw new Error('That path is outside the repository.');
  const actual = fs.realpathSync(requested);
  if (!inside(actual)) throw new Error('That link points outside the repository.');
  if (path.relative(base, actual).split(path.sep).includes('.git')) throw new Error('Git metadata is not part of the file browser.');
  return actual;
}
export function listRepoFiles(root, relative = '') {
  const directory = repoPath(root, relative);
  if (!fs.statSync(directory).isDirectory()) throw new Error('Choose a directory.');
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((e) => !hidden.has(e.name) && !e.isSymbolicLink())
    .map((e) => ({ name: e.name, directory: e.isDirectory(), path: path.relative(root, path.join(directory, e.name)).replaceAll('\\', '/') }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { path: path.relative(root, directory).replaceAll('\\', '/'), entries: entries.slice(0, 300), truncated: entries.length > 300 };
}
export function readRepoFile(root, relative) {
  const file = repoPath(root, relative);
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Choose a regular text file.');
    if (stat.size > LIMIT) throw new Error('Preview supports text files up to 256 KB.');
    const bytes = Buffer.alloc(stat.size);
    fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (bytes.includes(0)) throw new Error('Binary files cannot be previewed as text.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('This file is not UTF-8 text.'); }
    return { path: relative, text, bytes: stat.size };
  } finally { fs.closeSync(fd); }
}
export async function readRepoDiff(root, mode = 'combined') {
  if (!['combined', 'staged', 'unstaged'].includes(mode)) throw new Error('Choose a valid diff mode.');
  const args = ['-C', root, '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(mode === 'staged' ? ['--cached'] : mode === 'combined' ? ['HEAD'] : []), '--'];
  return new Promise((resolve, reject) => execFile('git', args, { windowsHide: true, maxBuffer: LIMIT, timeout: 10000 }, (err, out) => {
    if (err) reject(new Error(err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Diff exceeds 256 KB. Inspect a smaller set of changes with your editor.' : 'Cannot read this diff. For a new repo without a commit, choose Staged or Unstaged.'));
    else resolve({ mode, text: String(out) || 'No changes in this diff. Untracked files are available in Files.' });
  }));
}
