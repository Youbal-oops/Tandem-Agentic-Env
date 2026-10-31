// What a main agent is given to work with beyond its own tools: a per-conversation key, a small command-line tool
// to hand work to a child chat (scripts/tandem-job.mjs, talking to /api/jobs), and Tandem's own tools (browser, build,
// test) as an MCP server (scripts/tandem-tools-mcp.mjs, talking to /api/tools).

import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT, HOST, PORT } from './config.mjs';

const TOOLS_INSTRUCTIONS = `[Tandem tools]
You have Tandem's own tools (the "tandem" MCP server): project_commands, run_script (build, test, lint), dev_server_start / dev_server_status / dev_server_stop, and a browser of your own: browser_open, browser_snapshot, browser_click, browser_type, browser_screenshot, browser_console, browser_close. To check your work, run the project's tests and build with run_script, start the dev server, open it in the browser and look at the page. The user can see your browser window.

`;

const jobsInstructions = (jobScript) => `[Tandem child chats]\nWhen the user asks you to delegate work to Claude or Codex, use the local job command. Each job appears as a child chat attached to this conversation. Command: node "${jobScript}" start <claude|codex> "task description". Then use status <job-id>, result <job-id>, or message <job-id> "follow-up". Child tasks start in Edit mode; the user can change their permission mode in the child panel. Tasks share this repository. Read results before claiming completion. The user can also message the child directly. Do not print the TANDEM_JOB_TOKEN environment variable.`;

export function createDelegation() {
  const keys = new Map();
  const scriptRoot = process.env.TANDEM_JOB_SCRIPT_ROOT || APP_ROOT;
  const jobScript = path.join(scriptRoot, 'scripts', 'tandem-job.mjs');
  const toolsScript = path.join(scriptRoot, 'scripts', 'tandem-tools-mcp.mjs');
  // Set by the server once the workspace exists: whether Tandem's own tools are switched on right now.
  let toolsEnabled = () => false;
  return {
    keys,
    /** `fn()` says whether agents get Tandem's browser, build and test tools. It is read each time an agent starts or is sent a task. */
    setToolsEnabled(fn) { toolsEnabled = fn; },
    getAgentContext(config) {
      const key = crypto.randomBytes(24).toString('hex');
      keys.set(config.id, { key, conversationId: config.conversationId });
      return {
        environment: { TANDEM_JOB_URL: `http://${HOST}:${PORT}/api/jobs`, TANDEM_JOB_TOKEN: key, TANDEM_JOB_SCRIPT: jobScript },
        /** The MCP server for Tandem's tools, or null when they are off. A CLI started under Electron runs scripts with ELECTRON_RUN_AS_NODE. */
        mcp: () => (toolsEnabled() ? {
          command: process.execPath,
          args: [toolsScript],
          env: { TANDEM_TOOLS_URL: `http://${HOST}:${PORT}/api/tools`, TANDEM_TOOLS_TOKEN: key, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        } : null),
        taskInstructions: () => (toolsEnabled() ? TOOLS_INSTRUCTIONS : '') + jobsInstructions(jobScript),
      };
    },
  };
}
