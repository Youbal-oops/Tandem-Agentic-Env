import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Local folder picker: deliberately browses outside the active repository.
export async function listFolders(input = os.homedir()) {
  if (typeof input !== 'string' || input.length > 4096 || !path.isAbsolute(input)) throw new Error('Enter an absolute folder path.');
  const current = await fs.realpath(input);
  const entries = await fs.readdir(current, { withFileTypes: true });
  const directories = entries.filter(e => e.isDirectory() && e.name !== '.git').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const folders = await Promise.all(directories.slice(0, 500).map(async e => {
    const full = path.join(current, e.name);
    const repo = await fs.access(path.join(full, '.git')).then(() => true, () => false);
    return { name: e.name, path: full, repo };
  }));
  const roots = process.platform === 'win32'
    ? (await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async drive => {
      const root = `${drive}:\\`;
      return await fs.access(root).then(() => root, () => null);
    }))).filter(Boolean) : ['/'];
  return { path: current, parent: path.dirname(current), folders, truncated: directories.length > 500,
    home: os.homedir(), roots, repo: await fs.access(path.join(current, '.git')).then(() => true, () => false) };
}
