// The MCP server Tandem hands to each agent CLI (Claude Code, Codex). It speaks MCP over standard input and output and
// forwards every tool call to Tandem's local /api/tools endpoint with this conversation's key. It needs no packages.
// Started by the CLI itself; it only works when TANDEM_TOOLS_URL and TANDEM_TOOLS_TOKEN are set by Tandem.

import readline from 'node:readline';

const URL_ = process.env.TANDEM_TOOLS_URL;
const TOKEN = process.env.TANDEM_TOOLS_TOKEN;
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');

async function api(body) {
  if (!URL_ || !TOKEN) throw new Error('Run this from an agent launched by Tandem.');
  const response = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(660000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Tandem answered HTTP ${response.status}`);
  return result;
}

async function handle(m) {
  const { id, method, params } = m;
  const reply = (result) => id !== undefined && out({ jsonrpc: '2.0', id, result });
  const error = (code, message) => id !== undefined && out({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') reply({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tandem', version: '1.0.0' } });
    else if (method === 'ping') reply({});
    else if (method === 'tools/list') reply({ tools: (await api({ action: 'list' })).tools });
    else if (method === 'tools/call') reply(await api({ action: 'call', name: params?.name, arguments: params?.arguments || {} }));
    else if (id !== undefined) error(-32601, `Method not found: ${method}`); // notifications (no id) need no answer
  } catch (e) {
    if (method === 'tools/call') reply({ isError: true, content: [{ type: 'text', text: e.message }] });
    else error(-32603, e.message);
  }
}

// Calls can take minutes (a build); answer each as it finishes rather than one at a time.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  handle(m);
});
