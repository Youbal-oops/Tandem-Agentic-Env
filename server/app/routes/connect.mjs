// Connecting agents: which CLIs are installed and signed in, installing one, and opening its sign-in.

import { createConnect } from '../../connect.mjs';
import { CLIS, refreshSpecs, specs, toolsDir } from '../binaries.mjs';
import { findConnections } from '../connections.mjs';
import { createAccountSetup } from '../../account-setup.mjs';

export function createConnectRoutes({ hub, snapshot, agents }) {
  const connect = createConnect({
    specs, clis: CLIS, refresh: refreshSpecs,
    emit: (msg) => {
      hub.broadcast(msg);
      // A new CLI makes its agents available without a restart.
      if (msg.t === 'connect-changed') { hub.broadcast(snapshot()); scan(); }
    },
  });

  const setup = createAccountSetup({ connect, specs, clis: CLIS, refresh: refreshSpecs, tools: toolsDir(),
    // Connecting an account always ends with an agent for it, even one the user removed earlier.
    onConnected: (id) => { if (!agents.configs().some((c) => c.provider === id)) agents.add({ id: agents.configs().some((c) => c.id === id) ? undefined : id, provider: id, name: { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }[id] || id }); }, emit: (msg) => { if (msg.t === 'connect-changed') { hub.broadcast(snapshot()); scan(); } hub.broadcast(msg); } });

  /** Look for connections that have no planet yet (a CLI signed in, an API key set, a local model server running) and add one for each. */
  // Which CLIs are signed in, from the last check, so the Team chat never gives work to one that is signed out.
  let signed = {};
  let scanning = null;
  async function scan({ quiet = true } = {}) {
    if (scanning) return scanning;
    scanning = (async () => {
      try {
        const { clis } = await connect.status();
        signed = Object.fromEntries(clis.map((c) => [c.id, c.signedIn]));
        const added = agents.autoConnect(await findConnections({ cliStatus: clis }));
        if (added.length) { hub.broadcast(snapshot()); hub.broadcast({ t: 'notice', text: `New connection${added.length > 1 ? 's' : ''} found: added ${added.join(', ')}.` }); }
        else if (!quiet) hub.broadcast({ t: 'notice', text: 'No new connections found. Every connection that is ready already has a planet.' });
        return added;
      } catch (e) { console.error('Connection scan failed:', e.message); return []; } finally { scanning = null; }
    })();
    return scanning;
  }
  if (!process.env.TANDEM_NO_AUTOSCAN) setInterval(() => scan(), 5 * 60 * 1000).unref();
  return {
    scan,
    signedIn: () => signed,
    handlers: {
      'scan-connections': () => scan({ quiet: false }),
      // Answered twice: at once with what is known, then again when each sign-in has been checked (that takes some seconds).
      'setup-state': async (m, conn) => {
        const withAgents = (list) => list.map((p) => ({ ...p, hasAgent: agents.configs().some((c) => c.provider === p.id) }));
        conn.send({ t: 'setup-state', providers: withAgents(await setup.state({ quick: true })) });
        conn.send({ t: 'setup-state', providers: withAgents(await setup.state()) });
      },
      'setup-begin': (m, conn) => { setup.begin(String(m.cli)).catch((e) => conn.send({ t: 'notice', text: e.message })); },
      'setup-cancel': (m) => { setup.cancel(String(m.cli)); },
      'connect-status': async (m, conn) => conn.send({ t: 'connect-status', ...await connect.status() }),
      'connect-install': (m, conn) => { connect.install(String(m.cli)); conn.send({ t: 'connect-install', cli: m.cli, kind: 'started' }); },
      'connect-login': (m, conn) => { connect.login(String(m.cli)); conn.send({ t: 'notice', text: 'A sign-in window opened. Finish signing in there, then press Refresh here.' }); },
    },
  };
}
