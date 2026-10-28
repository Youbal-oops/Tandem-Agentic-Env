// Connecting agents: which CLIs are installed and signed in, installing one, and opening its sign-in.

import { createConnect } from '../../connect.mjs';
import { CLIS, refreshSpecs, specs } from '../binaries.mjs';
import { findConnections } from '../connections.mjs';

export function createConnectRoutes({ hub, snapshot, agents }) {
  const connect = createConnect({
    specs, clis: CLIS, refresh: refreshSpecs,
    emit: (msg) => {
      hub.broadcast(msg);
      // A new CLI makes its agents available without a restart.
      if (msg.t === 'connect-changed') { hub.broadcast(snapshot()); scan(); }
    },
  });

  /** Look for connections that have no planet yet (a CLI signed in, an API key set, a local model server running) and add one for each. */
  let scanning = null;
  async function scan({ quiet = true } = {}) {
    if (scanning) return scanning;
    scanning = (async () => {
      try {
        const { clis } = await connect.status();
        const added = agents.autoConnect(await findConnections({ cliStatus: clis }));
        if (added.length) { hub.broadcast(snapshot()); hub.broadcast({ t: 'notice', text: `New connection${added.length > 1 ? 's' : ''} found: added ${added.join(', ')}.` }); }
        else if (!quiet) hub.broadcast({ t: 'notice', text: 'No new connections found. Every connection that is ready already has a planet.' });
        return added;
      } catch (e) { console.error('Connection scan failed:', e.message); return []; } finally { scanning = null; }
    })();
    return scanning;
  }
  return {
    scan,
    handlers: {
      'scan-connections': () => scan({ quiet: false }),
      'connect-status': async (m, conn) => conn.send({ t: 'connect-status', ...await connect.status() }),
      'connect-install': (m, conn) => { connect.install(String(m.cli)); conn.send({ t: 'connect-install', cli: m.cli, kind: 'started' }); },
      'connect-login': (m, conn) => { connect.login(String(m.cli)); conn.send({ t: 'notice', text: 'A sign-in window opened. Finish signing in there, then press Refresh here.' }); },
    },
  };
}
