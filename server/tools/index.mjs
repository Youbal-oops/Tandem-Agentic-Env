// The tools Tandem gives its agents (over MCP, see scripts/tandem-tools-mcp.mjs): run the project's build and test
// scripts, run a dev server, and drive a real browser. Each call comes from one agent and runs in that agent's folder.
//
// The browser itself lives in the desktop shell (desktop/browser.cjs); the server reaches it through `bridge`, an object
// the shell puts on globalThis before the server starts. Without it (a plain `node server` run) the browser tools say so.

import { createRunner } from './runner.mjs';

const str = (description) => ({ type: 'string', description });
const ref = { type: 'integer', description: 'The number of an element from browser_snapshot.' };
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** Tools that can change files or start processes. They are refused while an agent is in a read-only mode. */
export const MUTATING_TOOLS = new Set(['run_script', 'dev_server_start']);

const TOOLS = [
  { name: 'project_commands', description: 'List the build, test and other scripts from this project\'s package.json, and which package manager it uses.', inputSchema: obj() },
  { name: 'run_script', description: 'Run a package.json script (for example build, test or lint) in your folder and return its output and exit code.',
    inputSchema: obj({ script: str('Script name from project_commands.'), args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments passed after --.' }, timeout_seconds: { type: 'integer', description: 'Give up after this long (default 120, at most 600).' } }, ['script']) },
  { name: 'dev_server_start', description: 'Start a long-running script such as a dev server and wait for its local address. One per agent.',
    inputSchema: obj({ script: str('Script name from project_commands, usually dev or start.'), args: { type: 'array', items: { type: 'string' } } }, ['script']) },
  { name: 'dev_server_status', description: 'Say whether your dev server is running, its address and its recent output.', inputSchema: obj() },
  { name: 'dev_server_stop', description: 'Stop your dev server.', inputSchema: obj() },
  { name: 'browser_open', description: 'Open a web page (http or https, including localhost) in your own Tandem browser window.', inputSchema: obj({ url: str('The address to open.') }, ['url']) },
  { name: 'browser_snapshot', description: 'Read the current page: its text, and a numbered list of the links, buttons and fields you can use with browser_click and browser_type.', inputSchema: obj() },
  { name: 'browser_click', description: 'Click an element from the latest browser_snapshot.', inputSchema: obj({ ref }, ['ref']) },
  { name: 'browser_type', description: 'Type into a field from the latest browser_snapshot, replacing what is there. Optionally press Enter afterwards.', inputSchema: obj({ ref, text: str('What to type.'), submit: { type: 'boolean', description: 'Press Enter afterwards.' } }, ['ref', 'text']) },
  { name: 'browser_screenshot', description: 'Take a picture of the current page.', inputSchema: obj() },
  { name: 'browser_console', description: 'Messages the page wrote to its console, and failed or error network requests, since the page was opened.', inputSchema: obj() },
  { name: 'browser_close', description: 'Close your browser window.', inputSchema: obj() },
];

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: String(message) }] });

/**
 * `cwdFor(agentId)` gives the folder an agent works in. `guard(agentId, toolName)` returns a refusal message or null.
 * `getBridge()` returns the desktop shell's browser, if there is one.
 */
export function createTools({ cwdFor, guard = () => null, getBridge = () => globalThis.tandemDesktop?.browser, runner = createRunner() }) {
  const browser = () => {
    const b = getBridge();
    if (!b) throw new Error('The browser tools need the Tandem desktop app (npm run desktop, or the installed app). This server is running without it.');
    return b;
  };
  const cleanUrl = (value) => {
    let u;
    try { u = new URL(String(value)); } catch { throw new Error('That is not a web address.'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https addresses can be opened.');
    if (u.username || u.password) throw new Error('Addresses with a username or password are not allowed.');
    return u.href;
  };

  const handlers = {
    project_commands: async (id) => { const cwd = cwdFor(id); return { packageManager: runner.packageManager(cwd), scripts: runner.scripts(cwd) }; },
    run_script: async (id, a) => runner.run(cwdFor(id), a.script, { args: a.args, timeoutSec: a.timeout_seconds }),
    dev_server_start: async (id, a) => runner.startServer(id, cwdFor(id), a.script, { args: a.args }),
    dev_server_status: async (id) => runner.serverStatus(id),
    dev_server_stop: async (id) => runner.stopServer(id),
    browser_open: async (id, a) => browser().open(id, cleanUrl(a.url)),
    browser_snapshot: async (id) => browser().snapshot(id),
    browser_click: async (id, a) => browser().click(id, Number(a.ref)),
    browser_type: async (id, a) => browser().type(id, Number(a.ref), String(a.text ?? '').slice(0, 5000), a.submit === true),
    browser_console: async (id) => browser().console(id),
    browser_close: async (id) => browser().close(id),
  };

  return {
    list: () => TOOLS,
    names: () => TOOLS.map((t) => t.name),
    /** Run one tool for one agent. Always resolves to an MCP result, with `isError` set when it did not work. */
    async call(agentId, name, args = {}) {
      if (!TOOLS.some((t) => t.name === name)) return fail(`Unknown tool: ${name}`);
      try {
        const refusal = MUTATING_TOOLS.has(name) ? guard(agentId, name) : null;
        if (refusal) return fail(refusal);
        const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        if (name === 'browser_screenshot') {
          const png = await browser().screenshot(agentId);
          return { content: [{ type: 'image', data: png, mimeType: 'image/png' }] };
        }
        return text(await handlers[name](agentId, input));
      } catch (e) { return fail(e.message); }
    },
    /** An agent was removed or the app is closing: stop what it started. */
    release(agentId) { runner.stopServer(agentId); try { getBridge()?.close(agentId); } catch {} },
    closeAll() { runner.closeAll(); try { getBridge()?.closeAll(); } catch {} },
    /** Show an agent's browser window to the user. */
    show(agentId) { return browser().show(agentId); },
  };
}
