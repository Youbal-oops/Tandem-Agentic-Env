import '@fontsource/playfair-display/400-italic.css';
import '@fontsource/inter/400.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './style.css';

import { createScene, AGENT_LOOK } from './scene.js';
import { ChatPanel, EDIT_TOOLS } from './chat.js';
import { InfoPanel } from './info.js';
import { createNet } from './net.js';
import { createDemo } from './demo.js';

const $ = (s, r = document) => r.querySelector(s);
const AGENTS = ['claude', 'codex'];
const NAMES = { claude: 'Claude', codex: 'Codex' };
const CODES = { claude: 'CLD', codex: 'CDX' };
const MODES = {
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
// Claude accepts these aliases; Codex model names change often, so it offers its default plus a custom name.
const MODEL_PRESETS = { claude: ['opus', 'sonnet', 'haiku', 'fable'], codex: [] };
const other = (id) => AGENTS.find((a) => a !== id);
const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));

const ui = { sel: null, hidden: false, demo: false, connected: false };
const awaiting = { claude: new Set(), codex: new Set() };
const bootAt = Date.now();

const scene = createScene($('#stage'));
let net = null;
let demo = null;

// ---------------------------------------------------------------- panels
const info = new InfoPanel($('#right'), { onSelect: (id) => select(id) });

const panels = {};
for (const id of AGENTS) {
  panels[id] = new ChatPanel($(`#chat-${id}`), {
    id,
    name: NAMES[id],
    otherName: NAMES[other(id)],
    modes: MODES[id],
    models: MODEL_PRESETS[id],
    handlers: {
      model: (model) => (ui.demo ? onMeta(id, { modelPref: model || null, model: model || (id === 'claude' ? 'claude-opus-5-5' : null) }) : net.send({ t: 'model', agent: id, model })),
      send: (text) => (ui.demo ? demo.respond(id, text) : net.send({ t: 'send', agent: id, text })),
      stop: () => net.send({ t: 'stop', agent: id }),
      mode: (mode) => (ui.demo ? onMeta(id, { mode }) : net.send({ t: 'mode', agent: id, mode })),
      newChat: () => (ui.demo ? (panels[id].reset([]), onMeta(id, { busy: false })) : net.send({ t: 'newchat', agent: id })),
      approve: (requestId, allow) => net.send({ t: 'approve', agent: id, requestId, allow }),
      forward: (text) => forward(id, text),
      focus: () => select(ui.sel === id ? null : id),
    },
  });
}

function forward(from, text) {
  const to = other(from);
  const quoted = text.split('\n').map((l) => '> ' + l).join('\n');
  panels[to].setDraft(`${NAMES[from]} just said this. Review it critically: what is wrong, missing or risky?\n\n${quoted}`);
  scene.handoff(from, to);
  info.log({ agent: from, text: `handed a reply to ${NAMES[to]} for review`, kind: 'info' });
  select(to);
  setTimeout(() => panels[to].focusInput(), 700);
}

// ---------------------------------------------------------------- activity: sparklines + tokens/sec
const act = Object.fromEntries(AGENTS.map((a) => [a, { chars: 0, rate: 0, spark: new Array(56).fill(0), tps: 0 }]));
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
  const subs = (s.subagents || []).slice(-4).map((x) => (x.status === 'running' || x.status === 'awaiting' ? 'running' : 'done'));
  let plan = (s.plan || []).map((p) => (p.done ? 'done' : p.active ? 'active' : 'todo'));
  if (m.busy && plan.length && !plan.includes('active')) {
    const i = plan.indexOf('todo');
    if (i >= 0) plan[i] = 'active';
  }
  return {
    busy: m.busy,
    thinking: !!s.thinking || (m.busy && !(s.tools?.running || []).length && !m.awaiting),
    awaiting: Math.max(awaiting[id].size, m.awaiting || 0),
    mode: m.mode,
    ctx: s.ctx?.window ? s.ctx.used / s.ctx.window : 0,
    limit: s.limits?.five?.u || 0,
    cache: s.cache || 0,
    tps: act[id].tps,
    moons: s.tools?.running || [],
    subagents: subs,
    tools: { total: s.tools?.total || 0, byClass: s.tools?.byClass || {} },
    plan,
    mcp: (s.mcp || []).map((x) => x.status),
  };
}
function syncScene(id) {
  scene.setStatus(id, status(id));
}

const warned = { claude: {}, codex: {} };
function watchLimits(id) {
  const s = panels[id].meta.stats;
  if (!s) return;
  const f = s.ctx?.window ? s.ctx.used / s.ctx.window : 0;
  const w = warned[id];
  if (f >= 0.9 && !w.crit) {
    w.crit = true;
    info.log({ agent: id, kind: 'err', text: `context ${Math.round(f * 100)}% full: expect compaction or truncation` });
  } else if (f >= 0.75 && !w.warn) {
    w.warn = true;
    info.log({ agent: id, kind: 'warn', text: `context ${Math.round(f * 100)}% full` });
  } else if (f < 0.5) {
    w.warn = w.crit = false;
  }
  for (const [key, label] of [['five', '5h'], ['seven', '7d']]) {
    const l = s.limits?.[key];
    if (l && l.u >= 0.8 && !w[key]) {
      w[key] = true;
      info.log({ agent: id, kind: l.u >= 0.95 ? 'err' : 'warn', text: `${label} usage limit at ${Math.round(l.u * 100)}%` });
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

// ---------------------------------------------------------------- work board (bottom)
const board = new Map();
let boardNo = 400;
const flap = (text) => [...text].map((c) => `<span>${c === ' ' ? '&nbsp;' : c}</span>`).join('');
const ST = {
  running: ['WORKING', null],
  awaiting: ['NEEDS OK', '#ffd27a'],
  done: ['DONE', '#7ee0a3'],
  error: ['FAILED', '#ff6b6b'],
  denied: ['DENIED', '#ffd27a'],
};
function boardSet(key, agent, route, state) {
  const [label, color] = ST[state] || ST.running;
  let row = board.get(key);
  if (!row) {
    const el = document.createElement('div');
    el.className = 'brow';
    el.style.setProperty('--c', AGENT_LOOK[agent].hex);
    const code = `${CODES[agent]}${String(++boardNo % 1000).padStart(3, '0')}`;
    el.innerHTML = `<span class="flap hot">${flap(code)}</span><span class="route"></span><span class="flap st"></span>`;
    $('.route', el).textContent = route;
    el.addEventListener('click', () => select(agent));
    const box = $('#ticker-items');
    box.querySelector('.idle')?.remove();
    box.prepend(el);
    row = { el, st: '' };
    board.set(key, row);
    while (box.children.length > 3) {
      const last = box.lastElementChild;
      for (const [k, r] of board) if (r.el === last) board.delete(k);
      last.remove();
    }
  }
  if (row.st !== state) {
    const st = $('.st', row.el);
    st.innerHTML = flap(label);
    st.classList.toggle('hot', state !== 'done');
    st.classList.remove('flip');
    void st.offsetWidth;
    st.classList.add('flip');
    st.style.setProperty('--c', color || AGENT_LOOK[agent].hex);
    row.st = state;
  }
}

// ---------------------------------------------------------------- events from the server (or the demo)
const toolSeen = new Map(); // tool id -> last status, for log lines

function logTool(id, d, replay = false) {
  const prev = toolSeen.get(d.id);
  if (prev === d.status) return;
  toolSeen.set(d.id, d.status);
  const what = `${d.name || 'tool'} ${d.summary || ''}`.trim().slice(0, 90);
  const at = replay ? d.at : Date.now();
  if (d.status === 'awaiting') info.log({ agent: id, kind: 'warn', text: `waiting for approval · ${what}`, at });
  else if (d.status === 'done') info.log({ agent: id, kind: 'ok', text: `${what}${d.ms ? ' · ' + (d.ms < 1000 ? d.ms + 'ms' : (d.ms / 1000).toFixed(1) + 's') : ''}`, at });
  else if (d.status === 'error') info.log({ agent: id, kind: 'err', text: `failed · ${what}`, at });
  else if (d.status === 'denied') info.log({ agent: id, kind: 'warn', text: `denied · ${what}`, at });
  else if (d.status === 'running' && !replay && prev === undefined) info.log({ agent: id, kind: 'info', text: `▸ ${what}`, at });
}

function onEvent(id, ev, replay = false) {
  panels[id].apply(ev, replay);
  if (ev.k === 'delta') act[id].chars += ev.text.length;
  if (ev.k === 'tool') {
    const d = panels[id].entries.get(ev.id)?.data || ev;
    const was = awaiting[id].has(ev.id);
    if (d.status === 'awaiting') awaiting[id].add(ev.id);
    else awaiting[id].delete(ev.id);
    logTool(id, d, replay);
    if (!replay) {
      act[id].chars += 20;
      const what = `${d.name || 'tool'} ${d.summary || ''}`.trim().slice(0, 70);
      const state = d.status === 'awaiting' ? 'awaiting' : d.status === 'done' ? 'done' : d.status === 'error' ? 'error' : d.status === 'denied' ? 'denied' : 'running';
      if (d.name) boardSet(`${id}:${ev.id}`, id, `${NAMES[id]} › ${what}`, state);
      if (d.status === 'done' && (EDIT_TOOLS.has(d.name) || (d.cls === 'edit'))) scene.workPacket(id);
      if (d.status === 'awaiting' && !was) scene.fx(id, 'ask');
    }
    syncScene(id);
  } else if (ev.k === 'user') {
    info.log({ agent: id, kind: 'info', text: `you › ${ev.text.replace(/\s+/g, ' ').slice(0, 80)}`, at: replay ? ev.at : Date.now() });
  } else if (ev.k === 'turn') {
    info.log({ agent: id, kind: ev.ok === false ? 'err' : 'ok', text: `turn ${ev.ok === false ? 'failed' : 'done'}${ev.ms ? ' in ' + (ev.ms / 1000).toFixed(1) + 's' : ''}${ev.cost ? ' · $' + ev.cost.toFixed(3) : ''}`, at: replay ? ev.at : Date.now() });
    if (!replay) boardSet(`${id}:turn:${ev.id}`, id, `${NAMES[id]} › finished a task`, ev.ok === false ? 'error' : 'done');
  } else if (ev.k === 'error') {
    info.log({ agent: id, kind: 'err', text: ev.text.split('\n')[0].slice(0, 120), at: replay ? ev.at : Date.now() });
  } else if (ev.k === 'note') {
    info.log({ agent: id, kind: 'info', text: ev.text, at: replay ? ev.at : Date.now() });
  }
}

function onMeta(id, meta) {
  panels[id].setMeta(meta);
  info.setMeta(id, panels[id].meta);
  watchLimits(id);
  syncScene(id);
  updateLabels();
}

// ---------------------------------------------------------------- selection + layout
function select(id) {
  ui.sel = id || null;
  document.body.dataset.sel = ui.sel || '';
  for (const a of AGENTS) {
    panels[a].root.classList.toggle('on', a === ui.sel);
    panels[a].root.classList.toggle('collapsed', !!ui.sel && a !== ui.sel);
  }
  scene.setSelected(ui.sel);
  info.setSelected(ui.sel);
  if (ui.sel) setTimeout(() => panels[ui.sel].focusInput(), 500);
  else document.activeElement?.blur?.();
}

function layout() {
  const vw = window.innerWidth;
  const lw = clamp(500, vw * 0.33, 700);
  const rw = vw > 1280 ? clamp(360, vw * 0.22, 460) : 0;
  const root = document.documentElement.style;
  root.setProperty('--lw', lw + 'px');
  root.setProperty('--rw', rw + 'px');
  scene.setInsets(ui.hidden ? 0 : lw - 40, ui.hidden ? 0 : Math.max(0, rw - 40));
}
window.addEventListener('resize', layout);

function setHidden(on) {
  ui.hidden = on;
  document.body.classList.toggle('hide-ui', on);
  $('#btn-ui').classList.toggle('on', on);
  $('#btn-ui').firstChild.textContent = on ? 'Show panels ' : 'Hide panels ';
  layout();
}

scene.onPick((id) => select(id && id !== ui.sel ? id : null));
let hovered = null;
scene.onHover((id) => (hovered = id));

// ---------------------------------------------------------------- labels on the scene
const labelEls = Object.fromEntries(AGENTS.map((a) => [a, $(`.pl[data-agent="${a}"]`)]));
const sunEl = $('.sl');
const box = new Map();
function measure() {
  for (const el of [...Object.values(labelEls), sunEl]) box.set(el, { w: el.offsetWidth, h: el.offsetHeight });
}
function updateLabels() {
  for (const a of AGENTS) {
    const [cls, text] = panels[a].state;
    labelEls[a].dataset.state = cls;
    const f = panels[a].meta.stats?.ctx;
    $('small', labelEls[a]).textContent = cls === 'ready' && f?.window ? `ctx ${Math.round((f.used / f.window) * 100)}%` : text;
  }
  measure();
}
const place = (el, x, y, anchor) => {
  const b = box.get(el) || { w: 0, h: 0 };
  el.style.transform = `translate(${Math.round(x - b.w / 2)}px, ${Math.round(anchor === 'above' ? y - b.h : y)}px)`;
};
// Labels vanish when they would sit underneath a side panel.
const clear = (x) => {
  const cs = getComputedStyle(document.documentElement);
  const lw = ui.hidden ? 0 : parseFloat(cs.getPropertyValue('--lw')) - 30;
  const rw = ui.hidden ? 0 : parseFloat(cs.getPropertyValue('--rw')) - 30;
  return x > lw + 40 && x < window.innerWidth - Math.max(rw, 0) - 40;
};
scene.onFrame(() => {
  for (const a of AGENTS) {
    const s = scene.screen(a);
    const el = labelEls[a];
    place(el, s.x, s.y - Math.min(s.r, 260) * (ui.sel === a ? 2.6 : 2.7) - 14, 'above');
    el.style.opacity = s.visible && clear(s.x) && !(ui.sel === a && s.r > 70) ? (hovered && hovered !== a ? '0.45' : '1') : '0';
  }
  const s = scene.screen('sun');
  place(sunEl, s.x, s.y + Math.min(s.r, 220) + 18, 'below');
  sunEl.style.opacity = s.visible && s.r < 200 && clear(s.x) ? '1' : '0';
});
setInterval(updateLabels, 500);

function setGit(git) {
  if (!git) return;
  $('#sl-repo').textContent = git.repo || 'codebase';
  $('#sl-git').textContent = git.branch ? `${git.branch} · ${git.changed ? git.changed + ' changed' : 'clean'}` : 'the codebase';
  $('#cwd').textContent = git.repo ? `…\\${git.repo}` : '';
  info.setGit(git);
  measure();
}

// ---------------------------------------------------------------- connection
function setConn(kind, text) {
  const c = $('#conn');
  c.className = 'conn ' + kind;
  $('em', c).textContent = text;
}
function setOffline(off) {
  for (const a of AGENTS) panels[a].setOffline(off && !ui.demo);
  updateLabels();
}

net = createNet({
  onStatus(kind, data) {
    if (kind === 'session') {
      setGit(data.git);
      for (const a of data.agents) onMeta(a.id, { available: a.available });
    } else if (kind === 'open') {
      ui.connected = true;
      setConn('ok', 'live · localhost');
      setOffline(false);
      info.log({ agent: 'claude', kind: 'info', text: 'connected to the Tandem server' });
    } else if (kind === 'closed') {
      ui.connected = false;
      setConn('bad', ui.demo ? 'demo' : 'offline');
      setOffline(true);
    }
  },
  onMessage(msg) {
    if (ui.demo) return;
    if (msg.t === 'snapshot') {
      info.clearLog();
      toolSeen.clear();
      for (const a of AGENTS) {
        const snap = msg.agents[a];
        awaiting[a].clear();
        for (const ev of snap.events) if (ev.k === 'tool' && ev.status === 'awaiting') awaiting[a].add(ev.id);
        panels[a].reset(snap.events);
        for (const ev of snap.events) if (ev.k === 'tool') logTool(a, panels[a].entries.get(ev.id)?.data || ev, true);
        onMeta(a, snap.meta);
      }
      setGit(msg.git);
    } else if (msg.t === 'ev') onEvent(msg.agent, msg.ev);
    else if (msg.t === 'meta') onMeta(msg.agent, msg.meta);
    else if (msg.t === 'fx') {
      scene.fx(msg.agent, msg.name);
      if (msg.name === 'compact') info.log({ agent: msg.agent, kind: 'warn', text: 'context compacted' });
    } else if (msg.t === 'reset') {
      awaiting[msg.agent].clear();
      panels[msg.agent].reset(msg.events);
      onMeta(msg.agent, msg.meta);
    } else if (msg.t === 'git') setGit(msg.git);
  },
});

// ---------------------------------------------------------------- demo
function setDemo(on) {
  if (on === ui.demo) return;
  ui.demo = on;
  $('#btn-demo').classList.toggle('on', on);
  if (on) {
    info.clearLog();
    toolSeen.clear();
    for (const a of AGENTS) {
      awaiting[a].clear();
      panels[a].reset([]);
      panels[a].setOffline(false);
      onMeta(a, { available: true, busy: false, awaiting: 0 });
    }
    setConn('', 'demo · no quota used');
    demo = createDemo({
      handle: (agent, ev) => onEvent(agent, ev),
      setMeta: (agent, meta) => onMeta(agent, meta),
      fx: (agent, name) => scene.fx(agent, name),
      log: (e) => info.log(e),
    });
    demo.run();
  } else {
    demo?.stop();
    info.clearLog();
    for (const a of AGENTS) {
      panels[a].reset([]);
      awaiting[a].clear();
      onMeta(a, { busy: false, awaiting: 0, stats: undefined });
    }
    if (ui.connected) {
      setConn('ok', 'live · localhost');
      net.send({ t: 'sync' });
    } else setConn('bad', 'offline');
    setOffline(!ui.connected);
  }
}

// ---------------------------------------------------------------- controls
const SKY = ['ship', 'meteor', 'comet', 'asteroid'];
let skyN = 0;
$('#btn-overview').addEventListener('click', () => select(null));
$('#btn-ui').addEventListener('click', () => setHidden(!ui.hidden));
$('#btn-demo').addEventListener('click', () => setDemo(!ui.demo));
$('#btn-sky').addEventListener('click', () => scene.sky(SKY[skyN++ % SKY.length]));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    select(null);
    return;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  const actions = { 1: () => select('claude'), 2: () => select('codex'), 0: () => select(null), h: () => setHidden(!ui.hidden), d: () => setDemo(!ui.demo), k: () => scene.sky(SKY[skyN++ % SKY.length]) };
  if (actions[k]) {
    e.preventDefault();
    actions[k]();
  }
});

// ---------------------------------------------------------------- clock
function tickClock() {
  const now = new Date();
  $('#clock').textContent = now.toTimeString().slice(0, 8);
  const s = Math.floor((Date.now() - bootAt) / 1000);
  $('#uptime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
tickClock();
setInterval(tickClock, 1000);

// ---------------------------------------------------------------- go
layout();
updateLabels();
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('boot')));
document.fonts?.ready.then(updateLabels);
setConn('', 'connecting');
const params = new URLSearchParams(location.search);
if (params.has('demo')) setDemo(true);
net.connect();
const startSel = params.get('sel');
if (startSel && AGENTS.includes(startSel)) select(startSel);
if (params.has('sky')) setTimeout(() => SKY.forEach((k, i) => setTimeout(() => scene.sky(k), i * 600)), 1500);
