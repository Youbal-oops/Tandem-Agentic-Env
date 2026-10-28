// Finding the connections this computer already has, so each one can get its own planet without being added by hand:
// an agent CLI that is installed and signed in, an API service whose key is set in the server environment, or a local
// model server that is running. Nothing here sends a message to a model; at most it asks an endpoint for its model list.

import { listApiModels } from './api-models.mjs';
import { API_SERVICES } from './services.mjs';

const APIS = { local: 3000, hosted: 8000 }; // how long to wait for /models, ms

/**
 * `cliStatus` is the `clis` list from connect.status(). Returns `[{ key, provider, name, service?, endpoint?, keyEnv?, model? }]`,
 * where `key` names the kind of connection (one planet per key).
 */
export async function findConnections({ cliStatus = [], env = process.env, fetchImpl = fetch, services = API_SERVICES } = {}) {
  const found = [];
  for (const cli of cliStatus) if (cli.installed && cli.signedIn === true) found.push({ key: `cli:${cli.id}`, provider: cli.id, name: cli.name.replace(/ (Code|CLI)$/, '') });
  const apis = await Promise.all(services.map(async (s) => {
    if (s.keyEnv && !env[s.keyEnv]) return null;
    try {
      const models = await listApiModels(s.endpoint, s.keyEnv, { fetchImpl, env, timeoutMs: s.keyEnv ? APIS.hosted : APIS.local });
      return { key: `api:${s.id}`, provider: 'api', service: s.id, name: s.name.replace(/ \(local\)$/, ''), endpoint: s.endpoint, keyEnv: s.keyEnv, model: models[0] };
    } catch { return null; } // not reachable now: it is looked for again on the next scan
  }));
  return [...found, ...apis.filter(Boolean)];
}
