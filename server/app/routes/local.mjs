// Things that belong to this computer: notes, the global prompt, learning mode and its journal, folders, files.

import os from 'node:os';
import { listFolders } from '../../folders.mjs';
import { listRepoFiles, readRepoDiff, readRepoFile } from '../../inspect.mjs';

export function createLocalRoutes({ agents, hub, snapshot }) {
  const inspect = (kind) => async (m, conn) => {
    const cwd = agents.cwd;
    try {
      const data = kind === 'files' ? listRepoFiles(cwd, m.path || '') : kind === 'file' ? readRepoFile(cwd, m.path) : await readRepoDiff(cwd, m.mode);
      conn.send({ t: 'inspect', request: m.request, kind, cwd, ...data });
    } catch (e) { conn.send({ t: 'inspect', request: m.request, cwd, error: e.message }); }
  };

  return {
    handlers: {
      sync: (m, conn) => conn.send(snapshot({ clone: true })),
      'child-create': (m, conn) => { const child = agents.childAction(m); conn.send({ t: 'child-open', id: child.id }); },
      'child-action': (m) => { agents.childAction(m); },
      localstate: (m, conn) => conn.send({ t: 'localstate', ...agents.localState(), saved: false }),
      savenotes: (m, conn) => conn.send({ t: 'localstate', ...agents.saveNotes(m.cwd, m.text), saved: true }),
      saveprompt: (m, conn) => conn.send({ t: 'prompt', ...agents.savePrompt(m.text, m.on) }),
      learningmode: (m) => hub.broadcast({ t: 'learnerprofile', ...agents.setLearningMode(m.on === true) }),
      savelearnerprofile: (m, conn) => conn.send({ t: 'learnerprofile', ...agents.saveLearnerProfile(m.profile) }),
      journal: (m, conn) => conn.send({ t: 'journal', entries: agents.journal() }),
      'journal-clear': (m, conn) => conn.send({ t: 'journal', entries: agents.clearJournal() }),
      folders: async (m, conn) => {
        try { conn.send({ t: 'folders', request: m.request, ...await listFolders(m.path || os.homedir()) }); }
        catch (e) { conn.send({ t: 'folders', request: m.request, error: e.message }); }
      },
      stopall: () => { agents.stopAll(); hub.broadcast({ t: 'notice', text: 'Stopped all agent sessions. Conversations are kept.' }); },
      files: inspect('files'),
      file: inspect('file'),
      diff: inspect('diff'),
    },
  };
}
