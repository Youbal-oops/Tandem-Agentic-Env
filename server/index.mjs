// Tandem local server.
//
// Runs Claude Code and Codex CLI as chat sessions and streams them to the browser UI.
// Security model: bound to 127.0.0.1 only; Host and Origin are checked on every request;
// the WebSocket needs a per-launch random token; agents can only start the two known CLI
// binaries. It can also open a terminal window or VS Code on a work folder (never a command the
// user typed). Repo changes require idle agents. CLI subprocesses do not
// inherit API keys; optional API chats read a named server environment variable.
//
// This file only assembles the pieces:  app/  (HTTP, WebSocket, routes)  ·  workspace/  (planets and chats)
// ·  agents/  (Claude and Codex adapters)  ·  learning/  (learning mode)  ·  the small modules beside it.

import path from 'node:path';
import { AGENT_IDS, HOST, PORT, ROOT } from './app/config.mjs';
import { modelChoices, specs } from './app/binaries.mjs';
import { createDelegation } from './app/delegation.mjs';
import { createGitStatus } from './app/git-status.mjs';
import { createHttpServer } from './app/http.mjs';
import { attachWebSocket, combineRoutes, createHub } from './app/ws.mjs';
import { API_SERVICES } from './app/services.mjs';
import { createAgentRoutes } from './app/routes/agent.mjs';
import { createConnectRoutes } from './app/routes/connect.mjs';
import { createLocalRoutes } from './app/routes/local.mjs';
import { createPushRoutes } from './app/routes/push.mjs';
import { createRepoRoutes } from './app/routes/repos.mjs';
import { createLaunchRoutes } from './app/routes/launch.mjs';
import { createImageStore } from './images.mjs';
import { createRepoService } from './repos.mjs';
import { createWorkspace } from './workspace.mjs';

const hub = createHub();
const delegation = createDelegation();
const images = createImageStore(ROOT);
const agents = createWorkspace({ root: ROOT, cwd: path.resolve(process.env.TANDEM_CWD || ROOT), specs, broadcast: hub.broadcast, getAgentContext: delegation.getAgentContext });
const repoService = createRepoService();
const gitStatus = createGitStatus({ getCwd: () => agents.cwd, broadcast: hub.broadcast });

let cloneState = { busy: false, text: '' };
const clone = { get: () => cloneState, set: (state) => { cloneState = state; hub.broadcast({ t: 'clone', ...state }); } };

/** Everything a browser needs to draw the whole UI. Clone progress is only included when it is relevant. */
const snapshot = ({ clone: withClone = false } = {}) => ({ t: 'snapshot', agents: agents.snapshot(), configs: agents.configs(), children: agents.children(), git: gitStatus.current, ...(withClone ? { clone: cloneState } : {}) });
const workDir = (id) => agents.workDirs().find((d) => d.id === (id || 'repo')) || agents.workDirs()[0];

const server = createHttpServer({ agents, images, delegationKeys: delegation.keys, gitStatus, getClone: clone.get, modelChoices, services: API_SERVICES });
const connectRoutes = createConnectRoutes({ hub, snapshot, agents });
attachWebSocket(server, {
  hub,
  snapshot,
  routes: combineRoutes(
    createLocalRoutes({ agents, hub, snapshot }),
    connectRoutes,
    createRepoRoutes({ agents, hub, gitStatus, repoService, clone, snapshot }),
    createPushRoutes({ agents, gitStatus, workDir }),
    createLaunchRoutes({ workDir }),
    createAgentRoutes({ agents, hub, snapshot }),
  ),
});
gitStatus.start();

function shutdown() {
  agents.closeAll();
}
process.on('exit', shutdown);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    shutdown();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Tandem API  http://${HOST}:${PORT}   (agents work in: ${agents.cwd})`);
  for (const id of [...AGENT_IDS, 'gemini']) console.log(`  ${id.padEnd(7)} ${specs[id] ? 'found' : 'not installed (Tandem can install it: More → Connect agents)'}`);
  console.log('Dev UI      http://localhost:5173  (npm run dev)');
  // Once the server is up, give any connection that is already set up (and has no planet yet) its own planet.
  if (!process.env.TANDEM_NO_AUTOSCAN) connectRoutes.scan();
});
