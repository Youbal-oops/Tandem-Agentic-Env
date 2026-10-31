// Opening the real terminal and editor: a terminal window in a worktree, and VS Code on the project or one file.

import { createLauncher } from '../../launcher.mjs';
import { repoPath } from '../../inspect.mjs';

export function createLaunchRoutes({ workDir, tools, launcher = createLauncher() }) {
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
