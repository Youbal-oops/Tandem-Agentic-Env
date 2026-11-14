// Things that belong to this computer: notes, the global prompt, learning mode and its journal, folders, files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFolders } from '../../folders.mjs';
import { listRepoFiles, readRepoDiff, readRepoFile, repoPath, writeRepoFile } from '../../inspect.mjs';

export function createLocalRoutes({ agents, hub, snapshot, workDir = () => ({ cwd: agents.cwd }) }) {
  const inspect = (kind) => async (m, conn) => {
    // `source` picks the folder: the repository, or one agent's worktree (where that agent's edits actually are).
    const source = typeof m.source === 'string' && m.source ? m.source : 'repo';
    const cwd = source === 'repo' ? agents.cwd : workDir(source).cwd;
    try {
      const data = kind === 'files' ? listRepoFiles(cwd, m.path || '') : kind === 'file' ? readRepoFile(cwd, m.path)
        : kind === 'save' ? writeRepoFile(cwd, m.path, m.text, m.mtime) : await readRepoDiff(cwd, m.mode);
      conn.send({ t: 'inspect', request: m.request, kind, cwd, source, ...data });
    } catch (e) { conn.send({ t: 'inspect', request: m.request, kind, cwd, source, path: typeof m.path === 'string' ? m.path : '', error: e.message }); }
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
      todomode: (m) => hub.broadcast({ t: 'learnerprofile', ...agents.setTodoMode(m.on === true) }),
      todos: async (m, conn) => conn.send(await agents.todosFor(String(m.agent))),
      savelearnerprofile: (m, conn) => conn.send({ t: 'learnerprofile', ...agents.saveLearnerProfile(m.profile) }),
      journal: (m, conn) => conn.send({ t: 'journal', entries: agents.journal(), docs: agents.learningDocs() }),
      'journal-clear': (m, conn) => conn.send({ t: 'journal', entries: agents.clearJournal() }),
      folders: async (m, conn) => {
        try { conn.send({ t: 'folders', request: m.request, ...await listFolders(m.path || os.homedir()) }); }
        catch (e) { conn.send({ t: 'folders', request: m.request, error: e.message }); }
      },
      savesettings: (m, conn) => { const out = agents.saveSettings(m.settings); hub.broadcast({ t: 'settings', settings: out }); },
      review: (m, conn) => conn.send({ t: 'review', review: agents.reviewView(String(m.agent)) }),
      'review-patch': async (m, conn) => {
        try { conn.send({ t: 'review-patch', request: m.request, agent: m.agent, file: m.file || '', text: await agents.reviewPatch(String(m.agent), m.file) }); }
        catch (e) { conn.send({ t: 'review-patch', request: m.request, agent: m.agent, file: m.file || '', error: e.message }); }
      },
      'review-approve': async (m) => {
        await agents.reviewApprove(String(m.agent));
        if (m.continue === true) await agents.action({ t: 'send', agent: String(m.agent), text: 'Approved in Tandem: the user reviewed your changes so far. Carry on where you stopped, in steps small enough to review, and say what each one is for before you edit.' });
      },
      'review-propose': (m) => { agents.reviewPropose(String(m.agent), m); },
      'structure-status': (m, conn) => conn.send({ t: 'structure', kind: 'status', status: agents.structureStatus() }),
      'structure-plan': async (m, conn) => {
        try {
          const { publicPlan } = await import('../../structure/index.mjs');
          conn.send({ t: 'structure', kind: 'plan', status: agents.structureStatus(), plan: publicPlan(await agents.structurePlan()) });
        } catch (e) { conn.send({ t: 'structure', kind: 'error', error: e.message }); }
      },
      'structure-create': async (m, conn) => {
        try {
          const out = await agents.structureCreate();
          conn.send({ t: 'structure', kind: 'created', ...out, status: agents.structureStatus() });
        } catch (e) { conn.send({ t: 'structure', kind: 'error', error: e.message }); }
      },
      'structure-fork': (m, conn) => { agents.markOrigin(agents.cwd, 'forked'); conn.send({ t: 'structure', kind: 'status', status: agents.structureStatus() }); },
      stopall: () => { agents.stopAll(); hub.broadcast({ t: 'notice', text: 'Stopped all agent sessions. Conversations are kept.' }); },
      files: inspect('files'),
      file: inspect('file'),
      diff: inspect('diff'),
      savefile: inspect('save'),
      /** Copy one file (from the repository or an agent's folder) into the shared team folder, so every agent can read it. */
      sharefile: (m, conn) => {
        try {
          const from = m.source === 'shared' ? null : workDir(typeof m.source === 'string' && m.source ? m.source : 'repo');
          if (!from) throw new Error('That file is already in the shared folder.');
          const src = repoPath(from.cwd, String(m.path || ''));
          if (!fs.statSync(src).isFile()) throw new Error('Choose a file.');
          if (fs.statSync(src).size > 5 * 1024 * 1024) throw new Error('Only files up to 5 MB can be shared.');
          const dir = agents.sharedDir();
          const ext = path.extname(src); const base = path.basename(src, ext);
          let name = base + ext; for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}${ext}`; // never overwrite what another agent left
          fs.copyFileSync(src, path.join(dir, name), fs.constants.COPYFILE_EXCL);
          conn.send({ t: 'shared', name, dir });
        } catch (e) { conn.send({ t: 'shared', error: e.message }); }
      },
    },
  };
}
