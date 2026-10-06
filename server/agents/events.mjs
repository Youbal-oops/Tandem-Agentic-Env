// The chat event list of one agent: inserting and merging events, notes and errors, and the plan.
// Everything the CLI adapters emit goes through here, so the browser sees one consistent event stream.

import { MAX_EVENTS } from './constants.mjs';
import { toolClass } from './tools.mjs';

/** `ctx` supplies `broadcast`, `fx(agent, name)`. */
export function createEvents(ctx) {
  const { broadcast, fx } = ctx;

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

  /** Append streamed text to an existing message or thinking block. */
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

  /** Anything still marked running when a turn ends abnormally is closed off. */
  function endTurnCleanup(a, why) {
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

  return { reindex, put, delta, note, fail, endTurnCleanup, planFromTool };
}
