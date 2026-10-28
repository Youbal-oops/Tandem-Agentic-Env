// Opening the real tools on this computer: a terminal window in a folder, and VS Code (or the default app) on a folder or file.
// The folders come from the server's own list of work folders and files are checked to be inside one, so nothing here runs a
// command the user typed. The command builders are pure so they can be tested.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // a PowerShell single-quoted string
const quoted = (s) => `"${String(s).replace(/(\\+)$/, '$1$1')}"`; // a Windows argument: wrapped in quotes, trailing backslashes doubled
const ps = (script) => ({ cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] });

/** The command that opens a terminal window in `dir`. Windows Terminal is used when it is installed, otherwise PowerShell. */
export function terminalLaunch(platform, dir, { wt = false } = {}) {
  if (platform === 'win32') return ps(wt ? `Start-Process wt.exe -ArgumentList '-d', ${q(quoted(dir))}` : `Start-Process powershell.exe -WorkingDirectory ${q(dir)} -ArgumentList '-NoExit'`);
  if (platform === 'darwin') return { cmd: 'open', args: ['-a', 'Terminal', dir] };
  return { cmd: 'x-terminal-emulator', args: [], cwd: dir };
}

/** The command that opens `target` in VS Code (`code` is its path or command), or in the default app when VS Code is missing. */
export function editorLaunch(platform, target, { code = null, isFile = false, line = 0 } = {}) {
  const goto = line > 0 ? `${target}:${line}` : target; // VS Code opens a file at a line with --goto path:line
  if (platform === 'win32') {
    if (!code) return ps(`Start-Process -FilePath ${q(target)}`);
    return ps(`Start-Process -FilePath ${q(code)} -ArgumentList ${isFile ? "'--goto', " : ''}${q(quoted(goto))}`);
  }
  if (platform === 'darwin') return code ? { cmd: 'open', args: ['-a', 'Visual Studio Code', ...(isFile && line > 0 ? ['--args', '--goto', goto] : [target])] } : { cmd: 'open', args: [target] };
  return code ? { cmd: code, args: isFile ? ['--goto', goto] : [target] } : { cmd: 'xdg-open', args: [target] };
}

export function createLauncher({ platform = process.platform, spawnImpl = spawn, exists = fs.existsSync, env = process.env, execImpl = execFileSync } = {}) {
  const found = (file, args) => { try { execImpl(file, args, { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } };

  /** What a command prints, or an empty string when it fails. */
  const capture = (file, args) => { try { return String(execImpl(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })); } catch { return ''; } };

  function findVsCode() {
    if (platform === 'win32') {
      // The usual install folders (VS Code and Insiders), per user or for everyone...
      const bases = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
      const usual = bases.flatMap((b) => ['Microsoft VS Code', 'Microsoft VS Code Insiders'].map((n) => path.join(b, n, 'Code.exe'))).find((p) => exists(p));
      if (usual) return usual;
      // ...or wherever it was installed, such as another drive: `code.cmd` is on the PATH, in <install>\bin, and Code.exe sits beside bin.
      for (const line of capture('where.exe', ['code.cmd']).split(/\r?\n/)) {
        const exe = line.trim() && path.join(path.dirname(path.dirname(line.trim())), 'Code.exe');
        if (exe && exists(exe)) return exe;
      }
      return null;
    }
    if (platform === 'darwin') return exists('/Applications/Visual Studio Code.app') ? 'Visual Studio Code' : null;
    return found('which', ['code']) ? 'code' : null;
  }

  function run({ cmd, args, cwd }) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref?.(); resolve(); });
    });
  }

  return {
    async openTerminal(dir) {
      const wt = platform === 'win32' && found('where.exe', ['wt.exe']);
      await run(terminalLaunch(platform, dir, { wt }));
      return { using: wt ? 'Windows Terminal' : platform === 'win32' ? 'PowerShell' : 'terminal' };
    },
    async openEditor(target, isFile = false, line = 0) {
      const code = findVsCode();
      await run(editorLaunch(platform, target, { code, isFile, line }));
      return { using: code ? 'VS Code' : 'default app' };
    },
  };
}
