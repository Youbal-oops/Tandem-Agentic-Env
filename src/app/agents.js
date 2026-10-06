// The agents in the UI: a chat panel per planet, events and meta arriving from the server, what each planet
// is drawn doing, and which agent is selected.

import { AGENT_LOOK } from '../looks.js';
import { ChatPanel, EDIT_TOOLS } from '../chat.js';
import { $ } from './state.js';

export function initAgents(app) {
  const { AGENTS, NAMES, CODES, MODES, MODEL_PRESETS, configs, panels, act, warned, awaiting, ui } = app;
  const other = (id) => AGENTS.find((a) => a !== id);

  // ---------------------------------------------------------------- panels
  function createPanel(id, provider = id) {
    awaiting[id] = new Set();
    act[id] = { chars: 0, rate: 0, spark: new Array(56).fill(0), tps: 0 };
    warned[id] = {};
    if (!$(`#chat-${id}`)) { const el = document.createElement('section'); el.id = `chat-${id}`; $('#left').append(el); }
    panels[id] = new ChatPanel($(`#chat-${id}`), {
      id,
      name: NAMES[id],
      otherName: NAMES[other(id)],
      modes: MODES[provider] || [{ id: 'read', label: 'Chat only', hint: 'No local file or shell tools' }],
      provider,
      number: AGENTS.indexOf(id) + 1,
      models: MODEL_PRESETS[provider] || [],
      handlers: {
        effort: (effort) => (ui.demo ? onMeta(id, { effort }) : app.net.send({ t: 'effort', agent: id, effort })),
        model: (model) => (ui.demo ? onMeta(id, { modelPref: model || null, model: model || (id === 'claude' ? 'claude-opus-5-5' : null) }) : app.net.send({ t: 'model', agent: id, model })),
        send: (text, attachments) => (ui.demo ? app.demo.respond(id, text) : app.net.send({ t: 'send', agent: id, text, attachments })),
        stop: () => app.net.send({ t: 'stop', agent: id }),
        mode: (mode) => (ui.demo ? onMeta(id, { mode }) : app.net.send({ t: 'mode', agent: id, mode })),
        newChat: () => (ui.demo ? (panels[id].reset([]), onMeta(id, { busy: false })) : app.net.send({ t: 'newchat', agent: id })),
        history: () => app.chatHistory.open(id),
        approve: (requestId, allow, answers) => app.net.send({ t: 'approve', agent: id, requestId, allow, answers }),
        implement: (skipDesign) => (ui.demo ? app.showNotice('Turn off Demo to use learning mode.') : app.net.send({ t: 'implement', agent: id, ...(skipDesign ? { skipDesign: true } : {}) })),
        confirmDesign: () => (ui.demo ? app.showNotice('Turn off Demo to use learning mode.') : app.net.send({ t: 'confirm-design', agent: id })),
        forward: (text) => forward(id, text),
        focus: () => select(ui.sel === id ? null : id),
      },
    });
    panels[id].setLearning(ui.learning);
    panels[id].setCheckpoint(ui.checkpoints[id]);
  }

  for (const id of AGENTS) createPanel(id);

  app.reconcile = function reconcile(next) {
    const { scene, info, childChats, labelEls } = app;
    for (const id of [...AGENTS]) if (!next.some((a) => a.id === id)) {
      panels[id].root.remove(); delete panels[id]; labelEls[id]?.remove(); delete labelEls[id]; scene.removePlanet(id);
      AGENTS.splice(AGENTS.indexOf(id), 1); delete configs[id];
    }
    next.forEach((c, i) => {
      configs[c.id] = c; NAMES[c.id] = c.name; CODES[c.id] = c.name.slice(0, 3).toUpperCase();
      if (!AGENTS.includes(c.id)) {
        AGENTS.push(c.id);
        const colors = ['#ffb25a', '#74e6ff', '#bda1ff', '#7ee0a3', '#ff8faf', '#ffe181', '#83a8ff', '#efadff'];
        const hex = colors[i % colors.length];
        AGENT_LOOK[c.id] = { ...AGENT_LOOK[c.provider === 'claude' ? 'claude' : 'codex'], name: c.name, hex, rim: hex, palette: ['#142335', '#416080', hex, '#fff2df'], orbit: { a: 150 + i * 76, b: 138 + i * 70, tilt: 0.03, speed: 0.07 / (1 + i * 0.3), phase: i * 2.4 }, radius: 18 };
        scene.addPlanet(c.id, AGENT_LOOK[c.id]);
        createPanel(c.id, c.provider);
        const el = document.createElement('div'); el.className = 'pl'; el.dataset.agent = c.id; el.innerHTML = '<b></b><small>idle</small>'; $('b', el).textContent = c.name; $('#plabels').append(el); labelEls[c.id] = el;
      }
      panels[c.id].root.style.setProperty('--c', AGENT_LOOK[c.id].hex);
      panels[c.id].setConversation(c.conversationId);
      onMeta(c.id, { available: c.available ?? true });
    });
    info.setAgents(next, AGENT_LOOK);
    if (ui.sel && !AGENTS.includes(ui.sel)) select(null);
    select(ui.sel);
    app.renderAgentList();
    childChats?.mountParents();
  };

  // Subagent chats count toward their parent's planet: moons, heat, the sparkline, the label and the log.
  const kidBusy = new Map();
  app.childActivity = function childActivity(id, chars = 0) {
    if (!panels[id]) return;
    const kids = app.childChats?.activity(id) || [];
    if (chars) act[id].chars += chars;
    for (const k of kids) {
      if (kidBusy.get(k.id) === k.busy) continue;
      if (kidBusy.has(k.id) || k.busy) app.info.log({ agent: id, kind: k.busy ? 'info' : k.status === 'failed' ? 'err' : 'ok', text: `${NAMES[k.provider] || k.provider} subagent ${k.busy ? 'started' : k.status === 'failed' ? 'failed' : 'finished'} › ${k.title.slice(0, 60)}` });
      kidBusy.set(k.id, k.busy);
    }
    app.info.setChildren(id, kids);
    syncScene(id);
    app.updateLabels();
  };

  function forward(from, text) {
    const choices = AGENTS.filter((a) => a !== from);
    if (!choices.length) return;
    const to = choices.length === 1 ? choices[0] : prompt(`Send review to agent ID: ${choices.join(', ')}`, choices[0]);
    if (!choices.includes(to)) return;
    const quoted = text.split('\n').map((l) => '> ' + l).join('\n');
    panels[to].setDraft(`${NAMES[from]} just said this. Review it critically: what is wrong, missing or risky?\n\n${quoted}`);
    app.scene.handoff(from, to);
    app.info.log({ agent: from, text: `handed a reply to ${NAMES[to]} for review`, kind: 'info' });
    select(to);
    setTimeout(() => panels[to].focusInput(), 700);
  }

  // ---------------------------------------------------------------- activity: sparklines + tokens/sec
  function drawSpark(id) {
    const ctx = panels[id].spark;
    const { width: w, height: h } = ctx.canvas;
    ctx.clearRect(0, 0, w, h);
    const col = AGENT_LOOK[id].hex;
    const values = act[id].spark;
    const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - (Math.log10(1 + v) / 3.4) * (h - 10)]);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, col + '66');
    g.addColorStop(1, col + '00');
    ctx.beginPath();
    ctx.moveTo(0, h);
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = col;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /** Everything the planet needs to draw an agent, derived from the latest meta. */
  function status(id) {
    const m = panels[id].meta;
    const s = m.stats || {};
    const kids = app.childChats?.activity(id) || [];
    const subs = [...(s.subagents || []).map((x) => (x.status === 'running' || x.status === 'awaiting' ? 'running' : 'done')), ...kids.map((k) => (k.busy ? 'running' : 'done'))].slice(-4);
    const kidsWorking = kids.some((k) => k.busy);
    let plan = (s.plan || []).map((p) => (p.done ? 'done' : p.active ? 'active' : 'todo'));
    if (m.busy && plan.length && !plan.includes('active')) {
      const i = plan.indexOf('todo');
      if (i >= 0) plan[i] = 'active';
    }
    return {
      busy: m.busy,
      thinking: !!s.thinking || kidsWorking || (m.busy && !(s.tools?.running || []).length && !m.awaiting),
      awaiting: Math.max(awaiting[id].size, m.awaiting || 0, kids.filter((k) => k.awaiting).length),
      mode: m.mode,
      ctx: s.ctx?.window ? s.ctx.used / s.ctx.window : 0,
      limit: s.limits?.five?.u || 0,
      cache: s.cache || 0,
      tps: act[id].tps,
      moons: s.tools?.running || [],
      subagents: subs,
      // Keep each kitten's own activity; the solar theme still consumes status strings.
      kittens: [...(s.subagents || []).map((x, i) => ({ ...x, id: x.id || `${id}-native-${i}` })), ...kids],
      tools: { total: s.tools?.total || 0, byClass: s.tools?.byClass || {} },
      plan,
      mcp: (s.mcp || []).map((x) => x.status),
    };
  }
  function syncScene(id) {
    app.scene.setStatus(id, status(id));
  }
  app.syncScene = syncScene;

  function watchLimits(id) {
    const s = panels[id].meta.stats;
    if (!s) return;
    const f = s.ctx?.window ? s.ctx.used / s.ctx.window : 0;
    const w = warned[id];
    if (f >= 0.9 && !w.crit) {
      w.crit = true;
      app.info.log({ agent: id, kind: 'err', text: `context ${Math.round(f * 100)}% full: expect compaction or truncation` });
    } else if (f >= 0.75 && !w.warn) {
      w.warn = true;
      app.info.log({ agent: id, kind: 'warn', text: `context ${Math.round(f * 100)}% full` });
    } else if (f < 0.5) {
      w.warn = w.crit = false;
    }
    for (const [key, label] of [['five', '5h'], ['seven', '7d']]) {
      const l = s.limits?.[key];
      if (l && l.u >= 0.8 && !w[key]) {
        w[key] = true;
        app.info.log({ agent: id, kind: l.u >= 0.95 ? 'err' : 'warn', text: `${label} usage limit at ${Math.round(l.u * 100)}%` });
      } else if (l && l.u < 0.6) w[key] = false;
    }
  }

  setInterval(() => {
    for (const id of AGENTS) {
      const a = act[id];
      a.rate = a.rate * 0.55 + a.chars * 4 * 0.45; // chars per second
      a.tps = a.rate / 4;
      a.spark.push(a.rate);
      a.spark.shift();
      a.chars = 0;
      drawSpark(id);
      syncScene(id);
    }
  }, 250);

  // ---------------------------------------------------------------- events from the server (or the demo)
  const toolSeen = new Map(); // tool id -> last status, for log lines
  app.resetToolLog = () => toolSeen.clear();

  app.logTool = function logTool(id, d, replay = false) {
    const prev = toolSeen.get(d.id);
    if (prev === d.status) return;
    toolSeen.set(d.id, d.status);
    const what = `${d.name || 'tool'} ${d.summary || ''}`.trim().slice(0, 90);
    const at = replay ? d.at : Date.now();
    const { info } = app;
    if (d.status === 'awaiting') info.log({ agent: id, kind: 'warn', text: `waiting for approval · ${what}`, at });
    else if (d.status === 'done') info.log({ agent: id, kind: 'ok', text: `${what}${d.ms ? ' · ' + (d.ms < 1000 ? d.ms + 'ms' : (d.ms / 1000).toFixed(1) + 's') : ''}`, at });
    else if (d.status === 'error') info.log({ agent: id, kind: 'err', text: `failed · ${what}`, at });
    else if (d.status === 'denied') info.log({ agent: id, kind: 'warn', text: `denied · ${what}`, at });
    else if (d.status === 'running' && !replay && prev === undefined) info.log({ agent: id, kind: 'info', text: `▸ ${what}`, at });
  };

  function onEvent(id, ev, replay = false) {
    const { info, scene } = app;
    panels[id].apply(ev, replay);
    if (ev.k === 'delta') act[id].chars += ev.text.length;
    if (ev.k === 'tool') {
      const d = panels[id].entries.get(ev.id)?.data || ev;
      const was = awaiting[id].has(ev.id);
      if (d.status === 'awaiting') awaiting[id].add(ev.id);
      else awaiting[id].delete(ev.id);
      app.logTool(id, d, replay);
      if (!replay) {
        act[id].chars += 20;
        const what = `${d.name || 'tool'} ${d.summary || ''}`.trim().slice(0, 70);
        const state = d.status === 'awaiting' ? 'awaiting' : d.status === 'done' ? 'done' : d.status === 'error' ? 'error' : d.status === 'denied' ? 'denied' : 'running';
        if (d.name) app.boardSet(`${id}:${ev.id}`, id, `${NAMES[id]} › ${what}`, state);
        if (d.status === 'done' && (EDIT_TOOLS.has(d.name) || (d.cls === 'edit'))) scene.workPacket(id);
        if (d.status === 'awaiting' && !was) scene.fx(id, 'ask');
      }
      syncScene(id);
    } else if (ev.k === 'user') {
      info.log({ agent: id, kind: 'info', text: `you › ${ev.text.replace(/\s+/g, ' ').slice(0, 80)}`, at: replay ? ev.at : Date.now() });
    } else if (ev.k === 'turn') {
      info.log({ agent: id, kind: ev.ok === false ? 'err' : 'ok', text: `turn ${ev.ok === false ? 'failed' : 'done'}${ev.ms ? ' in ' + (ev.ms / 1000).toFixed(1) + 's' : ''}${ev.cost ? ' · $' + ev.cost.toFixed(3) : ''}`, at: replay ? ev.at : Date.now() });
      if (!replay) app.boardSet(`${id}:turn:${ev.id}`, id, `${NAMES[id]} › finished a task`, ev.ok === false ? 'error' : 'done');
    } else if (ev.k === 'error') {
      info.log({ agent: id, kind: 'err', text: ev.text.split('\n')[0].slice(0, 120), at: replay ? ev.at : Date.now() });
    } else if (ev.k === 'note') {
      info.log({ agent: id, kind: 'info', text: ev.text, at: replay ? ev.at : Date.now() });
    }
  }
  app.onEvent = onEvent;

  function onMeta(id, meta) {
    panels[id].setMeta(meta);
    app.info.setMeta(id, panels[id].meta);
    watchLimits(id);
    syncScene(id);
    app.updateLabels();
  }
  app.onMeta = onMeta;

  // ---------------------------------------------------------------- selection
  function select(id) {
    if (id && !panels[id]) return;
    app.childChats?.parentSelected(id);
    ui.sel = id || null;
    document.body.dataset.sel = ui.sel || '';
    for (const a of AGENTS) {
      panels[a].root.classList.toggle('on', a === ui.sel);
      panels[a].root.classList.toggle('collapsed', a !== ui.sel);
    }
    app.scene.setSelected(ui.sel);
    app.info.setSelected(ui.sel);
    if (ui.sel) setTimeout(() => { panels[ui.sel]?.focusInput(); panels[ui.sel]?.root.scrollIntoView({ block: 'nearest' }); }, 500);
    else document.activeElement?.blur?.();
  }
  app.select = select;

  /** Learning mode on or off: every main chat shows or hides its checkpoint controls. */
  app.setLearning = (on) => {
    ui.learning = on;
    for (const id of AGENTS) panels[id]?.setLearning(on);
    $('#btn-learning').setAttribute('aria-pressed', String(on));
    $('#btn-learning').firstElementChild.textContent = on ? 'on' : 'off';
  };
  /** Where each main agent is in its checkpoint cycle (build, design, implement, report). */
  app.setCheckpoint = (agent, checkpoint) => { ui.checkpoints[agent] = checkpoint; panels[agent]?.setCheckpoint(checkpoint); };
}
