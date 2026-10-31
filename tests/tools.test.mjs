import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../server/tools/runner.mjs';
import { createTools } from '../server/tools/index.mjs';
import { createWorkspace } from '../server/workspace.mjs';
import { createDelegation } from '../server/app/delegation.mjs';
import { STARTERS } from './fixtures/starters.mjs';

const mcpScript = fileURLToPath(new URL('../scripts/tandem-tools-mcp.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
  return dir;
};
const project = (t, scripts) => {
  const dir = tmp(t, 'tandem-tools-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts }));
  return dir;
};
const node = (code) => `node -e "${code}"`;

test('only package.json scripts run, and their output and exit code come back', async (t) => {
  const dir = project(t, { hello: node("console.log('hello from script')"), broken: node('process.exit(3)'), nap: node('setTimeout(() => {}, 20000)') });
  const runner = createRunner();
  assert.deepEqual(runner.scripts(dir).map((s) => s.name), ['hello', 'broken', 'nap']);
  const ok = await runner.run(dir, 'hello');
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /hello from script/);
  assert.equal((await runner.run(dir, 'broken')).exitCode, 3);
  await assert.rejects(runner.run(dir, 'rm -rf /'), /Give the name of a script/);
  await assert.rejects(runner.run(dir, 'missing'), /No script "missing".*Available: hello, broken, nap/);
  const slow = await runner.run(dir, 'nap', { timeoutSec: 1 });
  assert.equal(slow.timedOut, true);
});

test('a dev server is started once per agent, reports its address and stops', async (t) => {
  const dir = project(t, { dev: node("console.log('ready on http://localhost:5555/'); setInterval(() => {}, 1000)") });
  const runner = createRunner();
  t.after(() => runner.closeAll());
  const started = await runner.startServer('a', dir, 'dev');
  assert.equal(started.url, 'http://localhost:5555/');
  assert.equal(runner.serverStatus('a').running, true);
  await assert.rejects(runner.startServer('a', dir, 'dev'), /already running/);
  assert.deepEqual(runner.stopServer('a'), { stopped: true, script: 'dev' });
  assert.equal(runner.serverStatus('a').running, false);
  await assert.rejects(runner.startServer('b', project(t, { dev: node('process.exit(2)') }), 'dev'), /exited with code 2/);
});

test('tools run for the agent that called, refuse changes in read-only modes, and only open web pages', async (t) => {
  const dir = project(t, { build: node("console.log('built')") });
  const calls = [];
  const bridge = {
    open: async (id, url) => (calls.push(['open', id, url]), { url, title: 'Demo' }),
    snapshot: async () => ({ elements: [] }), click: async (id, ref) => ({ clicked: ref }), type: async () => ({}), console: async () => ({ console: [] }),
    screenshot: async () => 'PNGDATA', close: (id) => (calls.push(['close', id]), { closed: true }), closeAll() {}, show: async () => ({}),
  };
  const readOnly = new Set(['locked']);
  const tools = createTools({ cwdFor: () => dir, getBridge: () => bridge, guard: (id) => (readOnly.has(id) ? 'read-only mode' : null) });
  t.after(() => tools.closeAll());

  assert.ok(tools.list().length >= 10 && tools.list().every((x) => x.name && x.description && x.inputSchema.type === 'object'));
  const built = await tools.call('free', 'run_script', { script: 'build' });
  assert.match(built.content[0].text, /built/);
  const refused = await tools.call('locked', 'run_script', { script: 'build' });
  assert.deepEqual([refused.isError, refused.content[0].text], [true, 'read-only mode']);
  assert.equal((await tools.call('locked', 'project_commands')).isError, undefined, 'reading what scripts exist is allowed');

  assert.equal((await tools.call('free', 'browser_open', { url: 'http://localhost:3000/' })).isError, undefined);
  assert.deepEqual(calls.at(-1), ['open', 'free', 'http://localhost:3000/']);
  for (const url of ['file:///C:/secret.txt', 'javascript:alert(1)', 'http://user:pw@localhost/', 'not a url']) assert.equal((await tools.call('free', 'browser_open', { url })).isError, true, url);
  assert.deepEqual((await tools.call('free', 'browser_screenshot')).content[0], { type: 'image', data: 'PNGDATA', mimeType: 'image/png' });
  assert.match((await tools.call('free', 'nope')).content[0].text, /Unknown tool/);

  const bare = createTools({ cwdFor: () => dir, getBridge: () => undefined });
  assert.match((await bare.call('free', 'browser_open', { url: 'http://localhost/' })).content[0].text, /desktop app/);
});

test('the MCP script answers initialize, lists tools and forwards calls with the conversation key', async (t) => {
  const seen = [];
  const api = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = JSON.parse(body); seen.push({ auth: req.headers.authorization, m });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(m.action === 'list' ? { tools: [{ name: 'run_script', description: 'x', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: `ran ${m.name}` }] }));
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  t.after(() => api.close());
  const proc = spawn(process.execPath, [mcpScript], { env: { ...process.env, TANDEM_TOOLS_URL: `http://127.0.0.1:${api.address().port}/api/tools`, TANDEM_TOOLS_TOKEN: 'key-1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => proc.kill());
  const replies = new Map(); let buf = '';
  proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); } });
  const ask = async (id, method, params) => { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 30)); return replies.get(id); };

  const init = await ask(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'tandem');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); // no answer expected
  assert.equal((await ask(2, 'tools/list')).result.tools[0].name, 'run_script');
  assert.equal((await ask(3, 'tools/call', { name: 'run_script', arguments: { script: 'build' } })).result.content[0].text, 'ran run_script');
  assert.ok(seen.every((s) => s.auth === 'Bearer key-1'));
  assert.equal((await ask(4, 'nope')).error.code, -32601);
});

test('Claude and Codex are started with the tandem MCP server only while the tools are switched on', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-mcp-launch-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const specs = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture, p] }]));
  const delegation = createDelegation();
  let w;
  delegation.setToolsEnabled(() => w.settings().agents.tools);
  w = createWorkspace({ initialAgents: STARTERS, root, cwd: repo, specs, broadcast() {}, getAgentContext: delegation.getAgentContext });
  w.saveSettings({ agents: { pingMain: false } });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); }); // close the CLIs first, then their folders can go
  const wait = async (check) => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
  const replies = (agent) => w.snapshot()[agent].events.filter((e) => e.k === 'msg' && e.role === 'assistant');
  const lastArgs = async (agent, text, count) => {
    w.action({ t: 'send', agent, text });
    await wait(() => replies(agent).length >= count && !w.snapshot()[agent].meta.busy);
    return JSON.parse(replies(agent).at(-1).text);
  };

  const codex = await lastArgs('codex', 'hello', 1);
  assert.ok(codex.args.some((a) => a.startsWith('mcp_servers.tandem.command=')), 'codex gets the server');
  const env = codex.args.find((a) => a.startsWith('mcp_servers.tandem.env='));
  assert.match(env, /TANDEM_TOOLS_URL = "http:\/\/127\.0\.0\.1:\d+\/api\/tools"/);
  assert.match(env, /TANDEM_TOOLS_TOKEN = "[0-9a-f]{48}"/);
  assert.match(codex.text, /Tandem tools/, 'the task tells the agent what it has');

  const claude = await lastArgs('claude', 'hello', 1);
  const config = JSON.parse(claude.args[claude.args.indexOf('--mcp-config') + 1]);
  assert.equal(config.mcpServers.tandem.args.at(-1).endsWith('tandem-tools-mcp.mjs'), true);

  w.saveSettings({ agents: { tools: false } });
  const off = await lastArgs('codex', 'again', 2);
  assert.ok(!off.args.some((a) => String(a).includes('mcp_servers.tandem')), 'switched off: no server');
  assert.doesNotMatch(off.text, /Tandem tools/);
  assert.match(off.text, /Tandem child chats/);

  // Read-only modes refuse tools that change things; Tandem's tools run outside the CLI's own sandbox.
  w.action({ t: 'mode', agent: 'codex', mode: 'read' });
  assert.match(w.toolGuard('codex'), /read-only/);
  w.action({ t: 'mode', agent: 'codex', mode: 'edit' });
  assert.equal(w.toolGuard('codex'), null);
});
