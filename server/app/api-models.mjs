// Asking a Chat Completions endpoint which models it offers (its /models list).

const isBad = (endpoint) => endpoint.username || endpoint.password || endpoint.search || endpoint.hash
  || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)));

export async function listApiModels(endpointText, keyEnvText, { fetchImpl = fetch, env = process.env, timeoutMs = 15000 } = {}) {
  const endpoint = new URL(String(endpointText || ''));
  const keyEnv = String(keyEnvText || '');
  if (isBad(endpoint)) throw new Error('Use HTTPS, or HTTP for a local model server.');
  if (keyEnv && !/^[A-Z][A-Z0-9_]{0,79}$/.test(keyEnv)) throw new Error('Enter an environment variable name, not an API key.');
  endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, '/models');
  if (!endpoint.pathname.endsWith('/models')) throw new Error('Use a Chat Completions endpoint ending in /chat/completions.');
  const response = await fetchImpl(endpoint, { headers: keyEnv ? { Authorization: `Bearer ${env[keyEnv] || ''}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Model request returned HTTP ${response.status}. Check the endpoint and connection.`);
  const data = await response.json();
  const models = (data.data || data.models || []).map((row) => typeof row === 'string' ? row : row?.id).filter((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(id)).slice(0, 200);
  if (!models.length) throw new Error('This endpoint did not return any usable model IDs.');
  return models;
}
