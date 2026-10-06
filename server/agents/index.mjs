// Chat sessions for Claude Code and Codex CLI.
//
// Both CLIs are driven through their machine-readable modes (no terminal emulation), see claude.mjs and
// codex.mjs. Everything they emit is normalised into a small set of events the browser renders as a chat,
// plus a `stats` block (context size, limits, tools, sub-agents ...) that drives the planets and the info panel.
//
// This file wires the pieces together and exposes the public API; the protocol work lives next to it:
//   constants.mjs  modes and limits        util.mjs    text and process helpers
//   tools.mjs      tool classes/summaries  stats.mjs   numbers for the info panel
//   events.mjs     the event list          claude.mjs  Claude stream-json adapter
//   codex.mjs      Codex exec adapter      codex-usage.mjs  Codex session-file reader

import { imageMetadata, claudeContent } from '../images.mjs';
import { EFFORTS, MODES, validModel } from './constants.mjs';
import { createEvents } from './events.mjs';
import { createClaude } from './claude.mjs';
import { createCodex } from './codex.mjs';
import { buildMeta, freshStats } from './stats.mjs';
import { createSummarizer } from './tools.mjs';
import { quietKill } from './util.mjs';

export { MODES, validModel };

export function createAgents({ cwd, specs, broadcast, providers = ['claude', 'codex'], environment = {}, taskInstructions = '', getInstructions = () => '', denyTool = () => null }) {
  const { rel, summarize } = createSummarizer(cwd);
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

  const meta = (a) => buildMeta(a, { specs, rel });
  const pushMeta = (a) => broadcast({ t: 'meta', agent: a.id, meta: meta(a) });
  const fx = (a, name) => broadcast({ t: 'fx', agent: a.id, name });

  // Shared by the two adapters.
  const ctx = { cwd, specs, environment, denyTool, broadcast, agents, rel, summarize, fx, pushMeta };
  Object.assign(ctx, createEvents(ctx));
  const { put, note, fail, endTurnCleanup, reindex } = ctx;
  const claude = createClaude(ctx);
  const codex = createCodex(ctx);

  /** Stop the process quietly (no failed-turn report). Claude restarts with new flags and resumes its session. */
  function dropProcess(a) {
    if (!a.proc) return;
    quietKill(a.proc);
    a.proc = null;
  }

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
        const proc = claude.ensure(a);
        proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: claudeContent(text, images) } }) + '\n');
      } else {
        codex.send(a, text, images);
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
    dropProcess(a);
    a.busy = false;
    endTurnCleanup(a, 'Stopped');
    if (id === 'codex') codex.stopPolling(a);
    note(a, 'Stopped.');
    pushMeta(a);
  }

  function setMode(id, mode) {
    const a = agents[id];
    if (!a || !MODES[id].some((m) => m.id === mode) || a.mode === mode) return;
    if (a.busy) return fail(a, 'Stop the current task before changing mode.');
    a.mode = mode;
    dropProcess(a); // Claude takes its mode as a launch flag
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
    dropProcess(a); // Claude takes the model as a launch flag
    note(a, next ? `Model set to ${next}.` : 'Model set back to the default.');
    pushMeta(a);
  }

  function newChat(id) {
    const a = agents[id];
    if (!a) return;
    dropProcess(a);
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
      if (!a || a.busy || ![null, '', ...EFFORTS].includes(effort)) return;
      if (id === 'codex' && effort === 'max') return fail(a, 'Use Extra high for Codex.');
      a.effort = effort || null;
      dropProcess(a);
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
        a.effort = EFFORTS.includes(s.effort) ? s.effort : null;
        a.turns = Number(s.turns) || 0; a.cost = Number(s.cost) || 0; a.seq = Number(s.seq) || 0; a.turnNo = Number(s.turnNo) || a.turns;
        reindex(a);
      }
    },
    newChat,
    /** Returns the answers that were accepted when this approved a selection card. */
    approve: (id, requestId, allow, answers) => (agents[id] ? claude.decide(agents[id], String(requestId), !!allow, answers) : null),
    snapshot: () => Object.fromEntries(Object.values(agents).map((a) => [a.id, { meta: meta(a), events: a.events }])),
    closeAll() {
      codex.close();
      for (const a of Object.values(agents)) if (a.proc) quietKill(a.proc);
    },
  };
}
