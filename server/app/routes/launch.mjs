// Opening the real terminal and editor: a terminal window in a worktree, and VS Code on the project or one file.

import { createLauncher } from '../../launcher.mjs';
import { repoPath } from '../../inspect.mjs';

export function createLaunchRoutes({ workDir, tools, vscode = null, launcher = createLauncher() }) {
  const reply = (conn, text) => conn.send({ t: 'notice', text });
  return {
    handlers: {
      'open-terminal': async (m, conn) => {
        const dir = workDir(m.source);
        try { const { using } = await launcher.openTerminal(dir.cwd); reply(conn, `Opened ${using} in ${dir.name}.`); }
        catch (e) { reply(conn, `Could not open a terminal: ${e.message}`); }
      },
      /** Bring an agent's own browser window forward (it opens when the agent first opens a page). */
      'show-browser': async (m, conn) => {
        try { await tools.show(String(m.source)); } catch (e) { reply(conn, e.message); }
      },
      /** Start the embedded VS Code if needed and say where it is, for the folder asked for. Asking is the user's go-ahead. */
      'vscode-open': async (m, conn) => {
        const dir = workDir(m.source);
        if (!vscode?.available()) { conn.send({ t: 'vscode', error: 'VS Code was not found on this computer. Install it from code.visualstudio.com, then press Start again.' }); return; }
        try { await vscode.start(); conn.send({ t: 'vscode', url: vscode.url(dir.cwd), source: dir.id, name: dir.name }); }
        catch (e) { conn.send({ t: 'vscode', error: e.message }); }
      },
      'vscode-stop': (m, conn) => { vscode?.stop(); conn.send({ t: 'vscode', stopped: true }); },
      'open-editor': async (m, conn) => {
        const dir = workDir(m.source);
        try {
          const file = typeof m.path === 'string' && m.path ? repoPath(dir.cwd, m.path) : null;
          const line = Number.isInteger(m.line) && m.line > 0 && m.line < 1e7 ? m.line : 0;
          const { using } = await launcher.openEditor(file || dir.cwd, !!file, line);
          reply(conn, `Opened ${file ? 'the file' : dir.name} in ${using}.${using === 'default app' ? ' VS Code was not found.' : ''}`);
        } catch (e) { reply(conn, `Could not open the editor: ${e.message}`); }
      },
    },
  };
}
