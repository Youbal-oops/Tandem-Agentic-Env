// How a main agent hands work to a child chat: it gets a per-conversation key and a small command-line tool
// (scripts/tandem-job.mjs) that talks to the local /api/jobs endpoint.

import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT, HOST, PORT } from './config.mjs';

export function createDelegation() {
  const keys = new Map();
  const jobScript = path.join(process.env.TANDEM_JOB_SCRIPT_ROOT || APP_ROOT, 'scripts', 'tandem-job.mjs');
  return {
    keys,
    getAgentContext(config) {
      const key = crypto.randomBytes(24).toString('hex');
      keys.set(config.id, { key, conversationId: config.conversationId });
      return {
        environment: { TANDEM_JOB_URL: `http://${HOST}:${PORT}/api/jobs`, TANDEM_JOB_TOKEN: key, TANDEM_JOB_SCRIPT: jobScript },
        taskInstructions: `[Tandem child chats]\nWhen the user asks you to delegate work to Claude or Codex, use the local job command. Each job appears as a child chat attached to this conversation. Command: node "${jobScript}" start <claude|codex> "task description". Then use status <job-id>, result <job-id>, or message <job-id> "follow-up". Child tasks start in Edit mode; the user can change their permission mode in the child panel. Tasks share this repository. Read results before claiming completion. The user can also message the child directly. Do not print the TANDEM_JOB_TOKEN environment variable.`,
      };
    },
  };
}
