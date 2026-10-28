// Opening the real terminal and editor: a terminal window in a worktree, and VS Code on the project or one file.

import { createLauncher } from '../../launcher.mjs';
import { repoPath } from '../../inspect.mjs';

export function createLaunchRoutes({ workDir, launcher = createLauncher() }) {
  const reply = (conn, text) => conn.send({ t: 'notice', text });
  return {
    handlers: {
      'open-terminal': async (m, conn) => {
        const dir = workDir(m.source);
        try { const { using } = await launcher.openTerminal(dir.cwd); reply(conn, `Opened ${using} in ${dir.name}.`); }
        catch (e) { reply(conn, `Could not open a terminal: ${e.message}`); }
      },
      'open-editor': async (m, conn) => {
        const dir = workDir(m.source);
        try {
          const file = typeof m.path === 'string' && m.path ? repoPath(dir.cwd, m.path) : null;
          const { using } = await launcher.openEditor(file || dir.cwd, !!file);
          reply(conn, `Opened ${file ? 'the file' : dir.name} in ${using}.${using === 'default app' ? ' VS Code was not found.' : ''}`);
        } catch (e) { reply(conn, `Could not open the editor: ${e.message}`); }
      },
    },
  };
}
