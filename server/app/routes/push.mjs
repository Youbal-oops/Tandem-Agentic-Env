// The Push dialog: what would be pushed, and pushing it (to a tandem/... branch only; see ../../gitpush.mjs).

import { pushBranch, pushPreview } from '../../gitpush.mjs';

export function createPushRoutes({ agents, gitStatus, workDir }) {
  return {
    handlers: {
      pushinfo: async (m, conn) => {
        try {
          const dir = workDir(m.source);
          conn.send({ t: 'pushinfo', source: dir.id, dirs: agents.workDirs().map(({ id, name }) => ({ id, name })), ...await pushPreview(dir.cwd) });
        } catch (e) { conn.send({ t: 'pushinfo', error: e.message }); }
      },
      push: async (m, conn) => {
        try {
          const dir = workDir(m.source);
          const { branch, dirty, committed } = await pushBranch(dir.cwd, { branch: m.branch, message: m.message, files: m.files });
          conn.send({ t: 'push-done', ok: true });
          conn.send({ t: 'notice', text: `Pushed ${dir.name.toLowerCase() === 'repository' ? 'the repository' : dir.name} to origin/${branch}.${committed ? ` Committed ${committed} file${committed === 1 ? '' : 's'}.` : ''}${dirty ? ` ${dirty} uncommitted change${dirty === 1 ? ' was' : 's were'} not included.` : ''}` });
          gitStatus.refresh();
        } catch (e) { conn.send({ t: 'push-done', ok: false, error: e.message }); }
      },
    },
  };
}
