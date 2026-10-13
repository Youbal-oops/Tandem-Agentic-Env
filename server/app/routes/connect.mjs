// Connecting agents: which CLIs are installed and signed in, installing one, and opening its sign-in.

import { createConnect } from '../../connect.mjs';
import { CLIS, refreshSpecs, specs } from '../binaries.mjs';

export function createConnectRoutes({ hub, snapshot }) {
  const connect = createConnect({
    specs, clis: CLIS, refresh: refreshSpecs,
    emit: (msg) => {
      hub.broadcast(msg);
      // A new CLI makes its agents available without a restart.
      if (msg.t === 'connect-changed') hub.broadcast(snapshot());
    },
  });
  return {
    handlers: {
      'connect-status': async (m, conn) => conn.send({ t: 'connect-status', ...await connect.status() }),
      'connect-install': (m, conn) => { connect.install(String(m.cli)); conn.send({ t: 'connect-install', cli: m.cli, kind: 'started' }); },
      'connect-login': (m, conn) => { connect.login(String(m.cli)); conn.send({ t: 'notice', text: 'A sign-in window opened. Finish signing in there, then press Refresh here.' }); },
    },
  };
}
