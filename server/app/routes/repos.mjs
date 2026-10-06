// Repositories and planets: GitHub listing, cloning, switching, saved chats, adding and removing agents.

import path from 'node:path';

export function createRepoRoutes({ agents, hub, gitStatus, repoService, clone, snapshot }) {
  /** Tell everyone the repository (or the set of planets) changed. */
  const resnapshot = (opts) => hub.broadcast(snapshot(opts));

  return {
    handlers: {
      githubrepos: async (m, conn) => {
        try { conn.send({ t: 'githubrepos', ...await repoService.listAccountRepos(m.page ?? 1) }); }
        catch (e) { conn.send({ t: 'githubrepos', error: e.message }); }
      },
      clone: async (m) => {
        await agents.withRepoChange(async (switchTo) => {
          clone.set({ busy: true, text: 'Starting clone…' });
          let lastProgress = 0;
          try {
            const destination = await repoService.clone(m, (text) => {
              if (Date.now() - lastProgress < 250) return;
              lastProgress = Date.now(); clone.set({ busy: true, text });
            });
            switchTo(destination); gitStatus.reset();
            clone.set({ busy: false, ok: true, text: `Cloned and opened ${path.basename(destination)}.`, destination });
            resnapshot({ clone: true });
            await gitStatus.refresh();
          } catch (e) {
            clone.set({ busy: false, ok: false, text: e.message });
          }
        });
      },
      repo: async (m) => {
        agents.switchRepo(m.cwd); gitStatus.reset();
        resnapshot();
        await gitStatus.refresh();
      },
      'chat-history': (m, conn) => conn.send({ t: 'chat-history', agent: m.agent, cwd: agents.cwd, request: m.request, conversations: agents.chatHistory(m.agent) }),
      'chat-reopen': (m, conn) => {
        agents.reopenChat(m.agent, m.id, m.cwd);
        resnapshot();
        conn.send({ t: 'chat-reopened', agent: m.agent, id: m.id });
      },
      addagent: (m) => { agents.add(m.config || {}); resnapshot(); },
      removeagent: (m) => { agents.remove(m.agent); resnapshot(); },
    },
  };
}
