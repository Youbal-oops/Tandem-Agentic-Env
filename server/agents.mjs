// Chat sessions for Claude Code and Codex CLI.
//
// Both CLIs are driven through their machine-readable modes (no terminal emulation):
//   claude -p --input-format stream-json --output-format stream-json   (one live process, multi-turn,
//                                                                       approvals answered over stdio)
//   codex exec --json [resume <id>]                                     (one process per turn)
// Everything they emit is normalised into a small set of events the browser renders as a chat, plus a
// `stats` block (context size, limits, tools, sub-agents ...) that drives the planets and the info panel.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeContent, imageMetadata } from './images.mjs';

const MAX_EVENTS = 1500;
const MAX_OUT = 6000;

export const MODES = {
  claude: [
    { id: 'ask', label: 'Ask', hint: 'Asks before running anything that changes things' },
    { id: 'plan', label: 'Plan', hint: 'Read-only: explores and proposes, changes nothing' },
    { id: 'edit', label: 'Edit', hint: 'Edits files freely, asks before other actions' },
    { id: 'auto', label: 'Auto', hint: 'Claude approves low-risk actions on its own' },
  ],
  codex: [
    { id: 'read', label: 'Read-only', hint: 'Can look around, cannot change files' },
    { id: 'edit', label: 'Edit', hint: 'Can edit files in this folder, sandboxed' },
  ],
};
const CLAUDE_MODE_FLAG = { ask: 'default', plan: 'plan', edit: 'acceptEdits', auto: 'auto' };
const CODEX_SANDBOX = { read: 'read-only', edit: 'workspace-write' };

const CLASS_BY_NAME = {
  Read: 'read', Glob: 'read', LS: 'read', NotebookRead: 'read',
  Grep: 'search',
  WebSearch: 'web', WebFetch: 'web', Search: 'web',
  Bash: 'shell', PowerShell: 'shell', Shell: 'shell',
  Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Task: 'agent', Agent: 'agent',
  TodoWrite: 'plan', TaskCreate: 'plan', TaskUpdate: 'plan', TaskList: 'plan', TaskGet: 'plan', TaskStop: 'plan', TaskOutput: 'plan',
};
const toolClass = (name = '') => CLASS_BY_NAME[name] || (/^mcp__|\./.test(name) ? 'mcp' : 'other');

/** Model names are passed to the CLIs as arguments, so only plain identifiers are accepted. */
export const validModel = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(s);

const trunc = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
};

function trimDeep(v, n = 1500) {
  if (typeof v === 'string') return trunc(v, n);
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => trimDeep(x, n));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, trimDeep(x, n)]));
  return v;
}

function stringifyContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.text ?? (b?.type === 'image' ? '[image]' : JSON.stringify(b)))).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  if (process.platform === 'win32') {
    proc.stdin?.end();
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, (err) => { if (err && proc.exitCode === null) proc.kill(); });
  }
  else proc.kill('SIGTERM');
}

/** Environment for the agent processes: never inherit API keys (subscriptions only) or a parent session. */
function cleanEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k];
  if (env.CLAUDECODE) for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}

// ---------------------------------------------------------------- Codex local usage records
// Codex writes token counts and account limits into its own session files. Only the
// `token_count` lines are read, never the conversation.

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function recentDayDirs() {
  const base = path.join(CODEX_HOME, 'sessions');
  const dirs = new Set();
  const now = Date.now();
  for (let d = 0; d < 3; d++) {
    const t = new Date(now - d * 864e5);
    for (const [Y, M, D] of [[t.getFullYear(), t.getMonth() + 1, t.getDate()], [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]]) {
      dirs.add(path.join(base, String(Y), String(M).padStart(2, '0'), String(D).padStart(2, '0')));
    }
  }
  return [...dirs];
}
function findRollout(sessionId) {
  for (const dir of recentDayDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith(`-${sessionId}.jsonl`)) return path.join(dir, f);
    } catch {
      /* day folder does not exist */
    }
  }
  return null;
}
function newestRollout() {
  let best = null;
  for (const dir of recentDayDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    } catch {
      /* day folder does not exist */
    }
  }
  return best?.p || null;
}
function lastTokenCount(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 262144);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('token_count')) continue;
        try {
          const p = JSON.parse(lines[i]).payload;
          if (p?.type === 'token_count') return p;
        } catch {
          /* partial line at the start of the window */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* file vanished */
  }
  return null;
}

export function createAgents({ cwd, specs, broadcast, providers = ['claude', 'codex'], environment = {}, taskInstructions = '', getInstructions = () => '' }) {
  const rel = (p) => {
    p = String(p ?? '');
    const base = cwd.replace(/[\\/]+$/, '');
    return p.toLowerCase().startsWith(base.toLowerCase() + '\\') || p.toLowerCase().startsWith(base.toLowerCase() + '/') ? p.slice(base.length + 1) : p;
  };

  function summarize(name, input = {}) {
    const pick = (...ks) => ks.map((k) => input?.[k]).find((v) => typeof v === 'string' && v) || '';
    switch (name) {
      case 'Bash':
      case 'PowerShell':
        return trunc(pick('command'), 200);
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        return rel(pick('file_path', 'notebook_path'));
      case 'Glob':
      case 'Grep':
        return pick('pattern');
      case 'WebFetch':
        return pick('url');
      case 'WebSearch':
        return pick('query');
      case 'Task':
      case 'Agent':
        return trunc(pick('description', 'prompt'), 120);
      case 'TodoWrite':
        return `${(input.todos || []).length} items`;
      default:
        try {
          return trunc(JSON.stringify(input), 160);
        } catch {
          return '';
        }
    }
  }

  const freshStats = () => ({
    ctxUsed: 0,
    ctxWindow: 200000,
    tokens: { fresh: 0, cached: 0, out: 0, think: 0 },
    cache: 0,
    limits: { five: null, seven: null },
    toolTotal: 0,
    byClass: {},
    mcp: [],
    compactions: 0,
    errors: 0,
    denials: 0,
    thinking: false,
  });

  const agents = {};
  for (const id of providers) {
    agents[id] = {
      id,
      mode: id === 'claude' ? 'ask' : 'read',
      busy: false,
      sessionId: null,
      model: null,
      effort: null,
      proc: null,
      events: [],
      index: new Map(),
      starts: new Map(),
      approvals: new Map(),
      blocks: new Map(),
      streamed: new Set(),
      curMsg: null,
      seq: 0,
      turnNo: 0,
      cost: 0,
      lastTotal: 0,
      turns: 0,
      stderr: '',
      rollout: null,
      modelPref: id === 'claude' && validModel(process.env.TANDEM_CLAUDE_MODEL) ? process.env.TANDEM_CLAUDE_MODEL : null,
      taskItems: [],
      planSeen: new Set(),
      stats: freshStats(),
    };
  }

  function derive(a) {
    const running = [];
    const subagents = [];
    const touched = new Map();
    let plan = [];
    for (const e of a.events) {
      if (e.k === 'tool') {
        if ((e.status === 'running' || e.status === 'awaiting') && e.cls !== 'plan') running.push(e.cls || 'other');
        if (e.cls === 'agent') subagents.push({ id: e.id, name: e.summary || 'sub-agent', status: e.status });
        if (e.cls === 'edit' && e.status === 'done') {
          const p = e.detail?.file_path || e.detail?.notebook_path;
          if (p) touched.set(rel(p), (touched.get(rel(p)) || 0) + 1);
          for (const c of e.detail?.changes || []) if (c.path) touched.set(rel(c.path), (touched.get(rel(c.path)) || 0) + 1);
        }
      } else if (e.k === 'plan') plan = e.items || [];
    }
    return { running: running.slice(0, 12), subagents: subagents.slice(-6), touched: [...touched].slice(-12).map(([p, n]) => ({ p, n })), plan };
  }

  function meta(a) {
    const s = a.stats;
    const d = derive(a);
    return {
      busy: a.busy,
      mode: a.mode,
      model: a.model,
      modelPref: a.modelPref,
      effort: a.effort,
      session: !!a.sessionId,
      running: !!a.proc,
      cost: a.cost,
      turns: a.turns,
      awaiting: a.approvals.size,
      available: !!specs[a.id],
      stats: {
        ctx: { used: s.ctxUsed, window: s.ctxWindow },
        tokens: s.tokens,
        cache: s.cache,
        limits: s.limits,
        tools: { total: s.toolTotal, byClass: s.byClass, running: d.running },
        subagents: d.subagents,
        mcp: s.mcp,
        plan: d.plan,
        touched: d.touched,
        compactions: s.compactions,
        errors: s.errors,
        denials: s.denials,
        thinking: s.thinking,
      },
    };
  }
  const pushMeta = (a) => broadcast({ t: 'meta', agent: a.id, meta: meta(a) });
  const fx = (a, name) => broadcast({ t: 'fx', agent: a.id, name });

  function reindex(a) {
    a.index = new Map();
    a.events.forEach((e, i) => e.id && a.index.set(e.id, i));
  }

  function onToolStatus(a, e, prev) {
    if (e.status === 'denied' && prev !== 'denied') {
      a.stats.denials += 1;
      fx(a, 'deny');
    } else if (e.status === 'error' && prev !== 'error') {
      fx(a, 'error');
    }
  }

  /** Insert an event, or merge into the existing one with the same id. */
  function put(a, ev) {
    if (ev.id) {
      const i = a.index.get(ev.id);
      if (i !== undefined && a.events[i]) {
        const cur = a.events[i];
        const prev = cur.status;
        if (cur.k === 'tool' && ev.name && !ev.cls) ev.cls = toolClass(ev.name);
        Object.assign(cur, ev);
        if (cur.k === 'tool' && ev.status && ev.status !== prev) onToolStatus(a, cur, prev);
        broadcast({ t: 'ev', agent: a.id, ev: cur });
        return cur;
      }
    }
    if (ev.k === 'tool') {
      ev.cls = toolClass(ev.name);
      if (ev.cls !== 'plan') {
        a.stats.toolTotal += 1;
        a.stats.byClass[ev.cls] = (a.stats.byClass[ev.cls] || 0) + 1;
      }
    }
    if (ev.k !== 'delta') ev.at = ev.at || Date.now();
    a.events.push(ev);
    if (ev.id) a.index.set(ev.id, a.events.length - 1);
    if (a.events.length > MAX_EVENTS) {
      a.events.splice(0, a.events.length - MAX_EVENTS);
      reindex(a);
    }
    broadcast({ t: 'ev', agent: a.id, ev });
    return ev;
  }

  function delta(a, id, text) {
    const i = a.index.get(id);
    if (i !== undefined && a.events[i]) a.events[i].text = (a.events[i].text || '') + text;
    broadcast({ t: 'ev', agent: a.id, ev: { k: 'delta', id, text } });
  }

  const note = (a, text) => put(a, { k: 'note', id: `${a.id}:n${++a.seq}`, text });
  const fail = (a, text) => {
    a.stats.errors += 1;
    fx(a, 'error');
    return put(a, { k: 'error', id: `${a.id}:e${++a.seq}`, text });
  };

  function endTurnCleanup(a, why) {
    // Anything still marked running when a turn ends abnormally is closed off.
    for (const e of a.events) if (e.k === 'tool' && (e.status === 'running' || e.status === 'awaiting')) put(a, { k: 'tool', id: e.id, status: 'error', output: why });
    a.approvals.clear();
    a.stats.thinking = false;
  }

  function setPlanFromTodos(a, todos) {
    const items = (todos || []).map((t) => ({ text: t.content || t.activeForm || '', done: t.status === 'completed', active: t.status === 'in_progress' }));
    put(a, { k: 'plan', id: `${a.id}:plan`, items });
  }

  /** Claude's task-list tools (TodoWrite, or TaskCreate/TaskUpdate) become the plan shown on the planet. */
  function planFromTool(a, toolId, name, input) {
    if (!toolId || a.planSeen.has(`${toolId}:${name}`)) return;
    if (name === 'TodoWrite') {
      a.planSeen.add(`${toolId}:${name}`);
      return setPlanFromTodos(a, input?.todos);
    }
    if (name === 'TaskCreate' && input?.subject) {
      a.planSeen.add(`${toolId}:${name}`);
      a.taskItems.push({ text: String(input.subject), done: false, active: false });
    } else if (name === 'TaskUpdate' && input?.taskId !== undefined) {
      a.planSeen.add(`${toolId}:${name}`);
      const i = Number(input.taskId) - 1;
      const it = a.taskItems[i];
      if (!it) return;
      if (input.status === 'completed') Object.assign(it, { done: true, active: false });
      else if (input.status === 'in_progress') it.active = true;
      else if (input.status === 'deleted') a.taskItems.splice(i, 1);
      if (input.subject) it.text = String(input.subject);
    } else return;
    put(a, { k: 'plan', id: `${a.id}:plan`, items: a.taskItems.map((x) => ({ ...x })) });
  }

  // ------------------------------------------------------------------ Claude

  function ensureClaude(a) {
    if (a.proc) return a.proc;
    const args = [
      ...specs.claude.args,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', CLAUDE_MODE_FLAG[a.mode],
    ];
    if (a.modelPref) args.push('--model', a.modelPref);
    if (a.effort) args.push('--effort', a.effort);
    if (a.sessionId) args.push('--resume', a.sessionId);
    const proc = spawn(specs.claude.file, args, { cwd, env: { ...cleanEnv(), ...environment }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    a.proc = proc;
    a.lastTotal = 0;
    a.stderr = '';
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      if (proc.__quiet || a.proc !== proc) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) claudeLine(a, line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => (a.stderr = (a.stderr + d).slice(-2000)));
    proc.on('error', (e) => {
      if (proc.__quiet || a.proc !== proc) return;
      fail(a, `Could not start Claude Code: ${e.message}`);
      a.proc = null;
      a.busy = false;
      pushMeta(a);
    });
    proc.on('exit', (code) => {
      if (a.proc === proc) a.proc = null;
      if (proc.__quiet) return;
      if (a.busy) {
        a.busy = false;
        endTurnCleanup(a, 'Claude exited');
        fail(a, `Claude Code stopped unexpectedly (exit ${code}).${a.stderr ? '\n' + trunc(a.stderr.trim(), 600) : ''}`);
      }
      pushMeta(a);
    });
    return proc;
  }

  function claudeLine(a, line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          a.sessionId = m.session_id || a.sessionId;
          a.model = m.model || a.model;
          if (Array.isArray(m.mcp_servers)) a.stats.mcp = m.mcp_servers.map((s) => ({ name: String(s.name).replace(/^claude\.ai /, ''), status: s.status }));
          pushMeta(a);
        } else if (m.subtype === 'compact_boundary') {
          a.stats.compactions += 1;
          a.stats.ctxUsed = Math.min(a.stats.ctxUsed, Math.round((m.compact_metadata?.post_tokens || 0) || a.stats.ctxUsed * 0.15));
          note(a, 'Context was compacted to make room.');
          fx(a, 'compact');
          pushMeta(a);
        }
        break;
      case 'stream_event':
        claudeStream(a, m.event || {});
        break;
      case 'assistant':
        claudeAssistant(a, m);
        break;
      case 'user':
        claudeUser(a, m);
        break;
      case 'control_request':
        claudeControl(a, m);
        break;
      case 'rate_limit_event': {
        const w = m.rate_limit_info?.unifiedWindows || {};
        const conv = (x) => (x ? { u: Number(x.utilization) || 0, reset: Number(x.resetsAt) || 0 } : null);
        a.stats.limits = { five: conv(w.five_hour) || a.stats.limits.five, seven: conv(w.seven_day) || a.stats.limits.seven };
        pushMeta(a);
        break;
      }
      case 'result':
        claudeResult(a, m);
        break;
    }
  }

  function noteUsage(a, usage, withOutput) {
    if (!usage) return;
    const fresh = Number(usage.input_tokens) || 0;
    const cread = Number(usage.cache_read_input_tokens) || 0;
    const cnew = Number(usage.cache_creation_input_tokens) || 0;
    const total = fresh + cread + cnew;
    if (total > 0) {
      a.stats.ctxUsed = total + (withOutput ? Number(usage.output_tokens) || 0 : 0);
      a.stats.cache = cread / total;
    }
  }

  function claudeStream(a, e) {
    if (e.type === 'message_start') {
      a.curMsg = e.message?.id;
      a.streamed.add(a.curMsg);
      a.blocks = new Map();
      noteUsage(a, e.message?.usage, false);
      pushMeta(a);
      return;
    }
    const idx = e.index;
    const id = `${a.id}:${a.curMsg}:${idx}`;
    if (e.type === 'content_block_start') {
      const b = e.content_block || {};
      if (b.type === 'text') {
        put(a, { k: 'msg', id, role: 'assistant', text: '', done: false });
        a.blocks.set(idx, { type: 'text', id });
      } else if (b.type === 'thinking') {
        put(a, { k: 'think', id, text: '', done: false });
        a.blocks.set(idx, { type: 'thinking', id });
        a.stats.thinking = true;
        pushMeta(a);
      } else if (b.type === 'tool_use') {
        a.starts.set(b.id, Date.now());
        put(a, { k: 'tool', id: b.id, name: b.name, summary: '', status: 'running' });
        a.blocks.set(idx, { type: 'tool', id: b.id, name: b.name, json: '' });
        pushMeta(a);
      }
    } else if (e.type === 'content_block_delta') {
      const blk = a.blocks.get(idx);
      const d = e.delta || {};
      if (!blk) return;
      if (d.type === 'text_delta' && blk.type === 'text') delta(a, blk.id, d.text || '');
      else if (d.type === 'thinking_delta' && blk.type === 'thinking') delta(a, blk.id, d.thinking || '');
      else if (d.type === 'input_json_delta' && blk.type === 'tool') blk.json += d.partial_json || '';
    } else if (e.type === 'content_block_stop') {
      const blk = a.blocks.get(idx);
      if (!blk) return;
      if (blk.type === 'text') put(a, { k: 'msg', id: blk.id, done: true });
      else if (blk.type === 'thinking') {
        put(a, { k: 'think', id: blk.id, done: true });
        a.stats.thinking = false;
        pushMeta(a);
      } else if (blk.type === 'tool') {
        let input = {};
        try {
          input = JSON.parse(blk.json || '{}');
        } catch {
          /* partial input; the full assistant message will fill it in */
        }
        put(a, { k: 'tool', id: blk.id, summary: summarize(blk.name, input), detail: trimDeep(input) });
        planFromTool(a, blk.id, blk.name, input);
      }
    }
  }

  function claudeAssistant(a, m) {
    const msg = m.message || {};
    if (!m.parent_tool_use_id) noteUsage(a, msg.usage, true);
    const streamed = a.streamed.has(msg.id);
    (msg.content || []).forEach((b, i) => {
      if (b.type === 'tool_use') {
        const exists = a.index.has(b.id);
        if (!a.starts.has(b.id)) a.starts.set(b.id, Date.now());
        put(a, { k: 'tool', id: b.id, name: b.name, summary: summarize(b.name, b.input), detail: trimDeep(b.input), ...(exists ? {} : { status: 'running' }) });
        planFromTool(a, b.id, b.name, b.input);
      } else if (!streamed && b.type === 'text') {
        put(a, { k: 'msg', id: `${a.id}:${msg.id}:a${i}`, role: 'assistant', text: b.text || '', done: true });
      } else if (!streamed && b.type === 'thinking') {
        put(a, { k: 'think', id: `${a.id}:${msg.id}:a${i}`, text: b.thinking || '', done: true });
      }
    });
    pushMeta(a);
  }

  function claudeUser(a, m) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const started = a.starts.get(b.tool_use_id);
      put(a, {
        k: 'tool',
        id: b.tool_use_id,
        status: b.is_error ? 'error' : 'done',
        output: trunc(stringifyContent(b.content), MAX_OUT),
        ms: started ? Date.now() - started : undefined,
      });
    }
    pushMeta(a);
  }

  function claudeControl(a, m) {
    const r = m.request || {};
    if (r.subtype === 'can_use_tool') {
      a.approvals.set(m.request_id, { input: r.input, toolUseId: r.tool_use_id });
      put(a, {
        k: 'tool',
        id: r.tool_use_id,
        name: r.tool_name,
        summary: summarize(r.tool_name, r.input),
        detail: trimDeep(r.input),
        status: 'awaiting',
        requestId: m.request_id,
      });
      pushMeta(a);
    } else if (a.proc?.stdin?.writable) {
      // Anything else the CLI asks of its host is declined rather than left hanging.
      a.proc.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Not supported by Tandem' } }) + '\n');
    }
  }

  function claudeResult(a, m) {
    a.busy = false;
    const total = Number(m.total_cost_usd) || 0;
    const cost = Math.max(0, total - a.lastTotal);
    a.lastTotal = total;
    a.cost += cost;
    a.turns += 1;
    const u = m.usage || {};
    a.stats.tokens.fresh += Number(u.input_tokens) || 0;
    a.stats.tokens.cached += (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    a.stats.tokens.out += Number(u.output_tokens) || 0;
    a.stats.tokens.think += Number(u.output_tokens_details?.thinking_tokens) || 0;
    const mu = m.modelUsage && Object.values(m.modelUsage)[0];
    if (mu?.contextWindow) a.stats.ctxWindow = mu.contextWindow;
    for (const d of m.permission_denials || []) if (d.tool_use_id) put(a, { k: 'tool', id: d.tool_use_id, status: 'denied' });
    endTurnCleanup(a, 'Ended');
    if (m.is_error && m.result) fail(a, String(m.result));
    put(a, { k: 'turn', id: `${a.id}:t${++a.seq}`, ok: !m.is_error, ms: m.duration_ms, cost, steps: m.num_turns });
    pushMeta(a);
  }

  function decide(a, requestId, allow) {
    const ap = a.approvals.get(requestId);
    if (!ap || !a.proc?.stdin?.writable) return;
    const response = allow
      ? { behavior: 'allow', updatedInput: ap.input }
      : { behavior: 'deny', message: 'The user declined this action in Tandem.' };
    a.proc.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n');
    a.approvals.delete(requestId);
    put(a, { k: 'tool', id: ap.toolUseId, status: allow ? 'running' : 'denied' });
    pushMeta(a);
  }

  // ------------------------------------------------------------------ Codex

  /** Pull context size and account limits from Codex's own session records. */
  function pollCodex(a) {
    const file = (a.sessionId && (a.rollout || (a.rollout = findRollout(a.sessionId)))) || null;
    const own = file ? lastTokenCount(file) : null;
    const any = own || (() => {
      const f = newestRollout();
      return f ? lastTokenCount(f) : null;
    })();
    if (!any) return;
    let changed = false;
    if (own?.info) {
      const last = own.info.last_token_usage || {};
      const used = Number(last.total_tokens) || (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0);
      if (used !== a.stats.ctxUsed) changed = true;
      a.stats.ctxUsed = used;
      if (own.info.model_context_window) a.stats.ctxWindow = own.info.model_context_window;
      const input = Number(last.input_tokens) || 0;
      a.stats.cache = input ? (Number(last.cached_input_tokens) || 0) / input : 0;
    } else if (any.info?.model_context_window && !a.sessionId) {
      a.stats.ctxWindow = any.info.model_context_window;
    }
    const rl = any.rate_limits;
    if (rl) {
      const conv = (x) => (x ? { u: (Number(x.used_percent) || 0) / 100, reset: Number(x.resets_at) || 0 } : null);
      const next = { five: conv(rl.primary), seven: conv(rl.secondary) };
      if (JSON.stringify(next) !== JSON.stringify(a.stats.limits)) changed = true;
      a.stats.limits = next;
    }
    if (changed) pushMeta(a);
  }
  let codexPoll = null;
  function startCodexPolling(a) {
    clearInterval(codexPoll);
    codexPoll = setInterval(() => pollCodex(a), 1500);
  }
  function stopCodexPolling(a) {
    clearInterval(codexPoll);
    codexPoll = null;
    setTimeout(() => pollCodex(a), 600);
  }
  // Limits are account-wide, so show them even before the first message.
  const initialPoll = setTimeout(() => agents.codex && pollCodex(agents.codex), 800);
  const idlePoll = setInterval(() => agents.codex && !agents.codex.busy && pollCodex(agents.codex), 30000);
  idlePoll.unref();

  function sendCodex(a, text, images = []) {
    const args = [...specs.codex.args, 'exec', '--json', '--skip-git-repo-check', '-C', cwd, '-s', CODEX_SANDBOX[a.mode]];
    if (a.modelPref) args.push('-m', a.modelPref);
    if (a.effort) args.push('-c', `model_reasoning_effort="${a.effort}"`);
    if (a.sessionId) args.push('resume', a.sessionId);
    for (const image of images) args.push('--image', image.path);
    args.push('-');
    const proc = spawn(specs.codex.file, args, { cwd, env: { ...cleanEnv(), ...environment }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    a.proc = proc;
    a.stderr = '';
    startCodexPolling(a);
    let buf = '';
    let sawTurnEnd = false;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      if (proc.__quiet || a.proc !== proc) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line && codexLine(a, line)) sawTurnEnd = true;
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => (a.stderr = (a.stderr + d).slice(-2000)));
    proc.on('error', (e) => {
      if (proc.__quiet || a.proc !== proc) return;
      fail(a, `Could not start Codex: ${e.message}`);
      a.proc = null;
      a.busy = false;
      stopCodexPolling(a);
      pushMeta(a);
    });
    proc.on('exit', (code) => {
      if (a.proc === proc) a.proc = null;
      stopCodexPolling(a);
      if (proc.__quiet) return;
      if (a.busy) {
        a.busy = false;
        endTurnCleanup(a, 'Codex exited');
        if (!sawTurnEnd) {
          const hint = a.stderr.trim().split('\n').filter((l) => !/Reading prompt from stdin/i.test(l)).slice(-6).join('\n');
          fail(a, `Codex stopped${code ? ` (exit ${code})` : ''} before finishing.${hint ? '\n' + trunc(hint, 700) : ''}`);
        }
      }
      pushMeta(a);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(text);
  }

  /** Returns true when the line ended a turn. */
  function codexLine(a, line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return false;
    }
    const it = m.item || {};
    const id = it.id ? `${a.id}:${it.id}:${a.turnNo}` : null;
    switch (m.type) {
      case 'thread.started':
        a.sessionId = m.thread_id || a.sessionId;
        a.rollout = null;
        pushMeta(a);
        return false;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const done = m.type === 'item.completed';
        switch (it.type) {
          case 'agent_message':
            if (id) put(a, { k: 'msg', id, role: 'assistant', text: it.text || '', done });
            break;
          case 'reasoning':
            if (id) put(a, { k: 'think', id, text: it.text || '', done });
            if (a.stats.thinking === done) {
              a.stats.thinking = !done;
              pushMeta(a);
            }
            break;
          case 'command_execution': {
            if (!a.starts.has(id)) a.starts.set(id, Date.now());
            const failed = it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0);
            put(a, {
              k: 'tool',
              id,
              name: 'Shell',
              summary: trunc(String(it.command || '').replace(/^(?:\S*[\\/])?(?:bash|sh|zsh|powershell|pwsh)(?:\.exe)?\s+-\w*c\w*\s+/i, ''), 200),
              status: done ? (failed ? 'error' : 'done') : 'running',
              output: it.aggregated_output ? trunc(it.aggregated_output, MAX_OUT) : undefined,
              ms: done ? Date.now() - a.starts.get(id) : undefined,
            });
            break;
          }
          case 'file_change': {
            const files = (it.changes || []).map((c) => `${c.kind || 'edit'} ${rel(c.path)}`);
            put(a, { k: 'tool', id, name: 'Edit', summary: trunc(files.join(', '), 200), detail: { changes: it.changes }, status: done ? (it.status === 'failed' ? 'error' : 'done') : 'running' });
            break;
          }
          case 'mcp_tool_call':
            put(a, { k: 'tool', id, name: `${it.server || 'mcp'}.${it.tool || 'tool'}`, summary: '', detail: trimDeep(it.arguments), status: done ? (it.status === 'failed' ? 'error' : 'done') : 'running' });
            break;
          case 'web_search':
            put(a, { k: 'tool', id, name: 'Search', summary: it.query || '', status: done ? 'done' : 'running' });
            break;
          case 'todo_list':
          case 'plan':
            put(a, { k: 'plan', id, items: (it.items || []).map((x) => ({ text: x.text, done: !!x.completed })) });
            break;
          case 'error':
            fail(a, it.message || 'Codex reported an error');
            break;
        }
        pushMeta(a);
        return false;
      }
      case 'turn.completed': {
        a.busy = false;
        a.turns += 1;
        a.stats.thinking = false;
        const u = m.usage || {};
        a.stats.tokens.fresh += Math.max(0, (Number(u.input_tokens) || 0) - (Number(u.cached_input_tokens) || 0));
        a.stats.tokens.cached += Number(u.cached_input_tokens) || 0;
        a.stats.tokens.out += Number(u.output_tokens) || 0;
        a.stats.tokens.think += Number(u.reasoning_output_tokens) || 0;
        put(a, { k: 'turn', id: `${a.id}:t${++a.seq}`, ok: true, tokens: { in: u.input_tokens, out: u.output_tokens } });
        pushMeta(a);
        return true;
      }
      case 'turn.failed':
        a.busy = false;
        endTurnCleanup(a, 'Turn failed');
        fail(a, m.error?.message || 'The turn failed');
        put(a, { k: 'turn', id: `${a.id}:t${++a.seq}`, ok: false });
        pushMeta(a);
        return true;
      case 'error':
        fail(a, m.message || 'Codex reported an error');
        return false;
    }
    return false;
  }

  // ------------------------------------------------------------------ public

  function send(id, text, images = []) {
    const a = agents[id];
    if (!a || !specs[id]) return;
    if (a.busy) return fail(a, 'Still working. Stop the current task first.');
    text = String(text || '').trim();
    if (!text && !images.length) return;
    if (!text) text = 'Describe these images.';
    put(a, { k: 'user', id: `${a.id}:u${++a.seq}`, text, attachments: imageMetadata(images), at: Date.now() });
    // The global prompt goes first, once per session and again whenever its rendered text changes.
    const global = String(getInstructions(id) || '').trim();
    if (global && global !== a.promptSent) { text = `[Standing instructions from the user, apply for this whole session]\n${global}\n\n[Task]\n${text}`; a.promptSent = global; }
    if (taskInstructions) text += '\n\n' + taskInstructions;
    a.turnNo += 1;
    a.busy = true;
    pushMeta(a);
    try {
      if (id === 'claude') {
        const proc = ensureClaude(a);
        proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: claudeContent(text, images) } }) + '\n');
      } else {
        sendCodex(a, text, images);
      }
    } catch (e) {
      a.busy = false;
      fail(a, `Could not send: ${e.message}`);
      pushMeta(a);
    }
    pushMeta(a);
  }

  function stop(id) {
    const a = agents[id];
    if (!a || !a.proc) return;
    a.proc.__quiet = true;
    killTree(a.proc);
    a.proc = null;
    a.busy = false;
    endTurnCleanup(a, 'Stopped');
    if (id === 'codex') stopCodexPolling(a);
    note(a, 'Stopped.');
    pushMeta(a);
  }

  function setMode(id, mode) {
    const a = agents[id];
    if (!a || !MODES[id].some((m) => m.id === mode) || a.mode === mode) return;
    if (a.busy) return fail(a, 'Stop the current task before changing mode.');
    a.mode = mode;
    // Claude takes its mode as a launch flag; restart quietly and resume the same conversation.
    if (a.proc) {
      a.proc.__quiet = true;
      killTree(a.proc);
      a.proc = null;
    }
    note(a, `Mode set to ${MODES[id].find((m) => m.id === mode).label}.`);
    pushMeta(a);
  }

  /** Pick the model for the next messages. An empty value means "use the CLI's own default". */
  function setModel(id, model) {
    const a = agents[id];
    if (!a) return;
    const next = model ? String(model) : null;
    if (next && !validModel(next)) return fail(a, 'That does not look like a model name.');
    if (next === a.modelPref) return;
    if (a.busy) return fail(a, 'Stop the current task before changing the model.');
    a.modelPref = next;
    // Claude takes the model as a launch flag: restart quietly and resume the same conversation.
    if (a.proc) {
      a.proc.__quiet = true;
      killTree(a.proc);
      a.proc = null;
    }
    note(a, next ? `Model set to ${next}.` : 'Model set back to the default.');
    pushMeta(a);
  }

  function newChat(id) {
    const a = agents[id];
    if (!a) return;
    if (a.proc) {
      a.proc.__quiet = true;
      killTree(a.proc);
      a.proc = null;
    }
    const keep = { limits: a.stats.limits, ctxWindow: a.stats.ctxWindow, mcp: a.stats.mcp };
    Object.assign(a, { busy: false, sessionId: null, rollout: null, events: [], index: new Map(), starts: new Map(), approvals: new Map(), blocks: new Map(), streamed: new Set(), cost: 0, lastTotal: 0, turns: 0, taskItems: [], planSeen: new Set(), promptSent: null });
    a.stats = { ...freshStats(), ...keep };
    broadcast({ t: 'reset', agent: id, events: [], meta: meta(a) });
  }

  return {
    send,
    stop,
    setMode,
    setModel,
    setEffort(id, effort) {
      const a = agents[id];
      if (!a || a.busy || ![null, '', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return;
      if (id === 'codex' && effort === 'max') return fail(a, 'Use Extra high for Codex.');
      a.effort = effort || null;
      if (a.proc) { a.proc.__quiet = true; killTree(a.proc); a.proc = null; }
      pushMeta(a);
    },
    save: () => Object.fromEntries(Object.values(agents).map((a) => [a.id, {
      events: a.events, sessionId: a.sessionId, mode: a.mode, modelPref: a.modelPref,
      effort: a.effort, turns: a.turns, cost: a.cost, seq: a.seq, turnNo: a.turnNo,
    }])),
    restore(saved) {
      for (const a of Object.values(agents)) {
        const s = saved?.[a.id];
        if (!s) continue;
        a.events = Array.isArray(s.events) ? s.events : [];
        for (const e of a.events) if (e.k === 'tool' && ['running', 'awaiting'].includes(e.status)) e.status = 'error';
        a.sessionId = typeof s.sessionId === 'string' ? s.sessionId : null;
        if (MODES[a.id].some((m) => m.id === s.mode)) a.mode = s.mode;
        a.modelPref = validModel(s.modelPref) ? s.modelPref : null;
        a.effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(s.effort) ? s.effort : null;
        a.turns = Number(s.turns) || 0; a.cost = Number(s.cost) || 0; a.seq = Number(s.seq) || 0; a.turnNo = Number(s.turnNo) || a.turns;
        reindex(a);
      }
    },
    newChat,
    approve: (id, requestId, allow) => agents[id] && decide(agents[id], String(requestId), !!allow),
    snapshot: () => Object.fromEntries(Object.values(agents).map((a) => [a.id, { meta: meta(a), events: a.events }])),
    closeAll() {
      clearTimeout(initialPoll);
      clearInterval(idlePoll);
      clearInterval(codexPoll);
      for (const a of Object.values(agents)) if (a.proc) ((a.proc.__quiet = true), killTree(a.proc));
    },
  };
}
