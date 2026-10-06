// Messages addressed to one agent (send, stop, mode, model, approve, implement ...) and compatible-API model discovery.

import { MAX_TEXT } from '../config.mjs';

export function createAgentRoutes({ agents, hub, snapshot }) {
  const validEndpoint = (endpoint) => endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)));

  return {
    handlers: {
      /** Ask a Chat Completions endpoint which models it offers. */
      apimodels: async (m, conn) => {
        try {
          const endpoint = new URL(String(m.endpoint || ''));
          const keyEnv = String(m.keyEnv || '');
          if (validEndpoint(endpoint)) throw new Error('Use HTTPS, or HTTP for a local model server.');
          if (keyEnv && !/^[A-Z][A-Z0-9_]{0,79}$/.test(keyEnv)) throw new Error('Enter an environment variable name, not an API key.');
          endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, '/models');
          if (!endpoint.pathname.endsWith('/models')) throw new Error('Use a Chat Completions endpoint ending in /chat/completions.');
          const response = await fetch(endpoint, { headers: keyEnv ? { Authorization: `Bearer ${process.env[keyEnv] || ''}` } : {} });
          if (!response.ok) throw new Error(`Model request returned HTTP ${response.status}. Check the endpoint and connection.`);
          const data = await response.json();
          const models = (data.data || data.models || []).map((row) => typeof row === 'string' ? row : row?.id).filter((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(id)).slice(0, 200);
          if (!models.length) throw new Error('This endpoint did not return any usable model IDs.');
          conn.send({ t: 'apimodels', models });
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
