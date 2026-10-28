// Messages addressed to one agent (send, stop, mode, model, approve, implement ...) and compatible-API model discovery.

import { MAX_TEXT } from '../config.mjs';
import { listApiModels } from '../api-models.mjs';

export function createAgentRoutes({ agents, hub, snapshot }) {
  return {
    handlers: {
      /** Ask a Chat Completions endpoint which models it offers. */
      apimodels: async (m, conn) => {
        try {
          conn.send({ t: 'apimodels', models: await listApiModels(m.endpoint, m.keyEnv) });
        } catch (e) { conn.send({ t: 'apimodels', error: e.message }); }
      },
    },
    /** Anything else that names an agent goes to that agent. */
    async fallback(m) {
      if (typeof m.agent !== 'string') return false;
      if (m.t === 'send' && (typeof m.text !== 'string' || m.text.length > MAX_TEXT)) return;
      await agents.action(m);
      if (m.t === 'newchat') hub.broadcast(snapshot());
    },
  };
}
