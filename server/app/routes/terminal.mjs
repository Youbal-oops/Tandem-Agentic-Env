// The terminal drawer. One terminal per browser connection, stopped when the connection closes.

import { createTerminal } from '../../terminal.mjs';

export function createTerminalRoutes({ agents, workDir }) {
  return {
    handlers: {
      'term-open': (m, conn) => {
        const dir = workDir(m.source);
        if (!conn.term) conn.term = createTerminal({ cwd: dir.cwd, emit: conn.send });
        else if (m.source) conn.term.chdir(dir.cwd);
        conn.send({ t: 'term', kind: 'ready', dirs: agents.workDirs().map(({ id, name, cwd }) => ({ id, name, cwd })), ...conn.term.state() });
      },
      'term-run': (m, conn) => { if (conn.term && typeof m.line === 'string') conn.term.run(m.line); },
      'term-stop': (m, conn) => { conn.term?.interrupt(); },
    },
    onClose(conn) { conn.term?.close(); conn.term = null; },
  };
}
