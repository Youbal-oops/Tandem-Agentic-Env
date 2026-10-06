// Tandem local server.
//
// Runs Claude Code and Codex CLI as chat sessions and streams them to the browser UI.
// Security model: bound to 127.0.0.1 only; Host and Origin are checked on every request;
// the WebSocket needs a per-launch random token; agents can only start the two known CLI
// binaries. The one exception is the built-in terminal, which runs the lines the signed-in
// user types in the system shell (same token and origin checks, one terminal per connection,
// stopped when the connection closes). Repo changes require idle agents. CLI subprocesses do not
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
import { createAgentRoutes } from './app/routes/agent.mjs';
import { createLocalRoutes } from './app/routes/local.mjs';
import { createPushRoutes } from './app/routes/push.mjs';
import { createRepoRoutes } from './app/routes/repos.mjs';
import { createTerminalRoutes } from './app/routes/terminal.mjs';
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

const server = createHttpServer({ agents, images, delegationKeys: delegation.keys, gitStatus, getClone: clone.get, modelChoices });
attachWebSocket(server, {
  hub,
  snapshot,
  routes: combineRoutes(
    createLocalRoutes({ agents, hub, snapshot }),
    createRepoRoutes({ agents, hub, gitStatus, repoService, clone, snapshot }),
    createPushRoutes({ agents, gitStatus, workDir }),
    createTerminalRoutes({ agents, workDir }),
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
  for (const id of AGENT_IDS) console.log(`  ${id.padEnd(7)} ${specs[id] ? 'found' : 'NOT FOUND (npm install -g the CLI)'}`);
  console.log('Dev UI      http://localhost:5173  (npm run dev)');
});
