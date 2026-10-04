import { createFolderPicker } from './folders.js';
import '@fontsource/playfair-display/400-italic.css';
import '@fontsource/inter/400.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './style.css';
import './workspace.css';

import { AGENT_LOOK } from './looks.js';
import { ChatPanel, EDIT_TOOLS } from './chat.js';
import { InfoPanel } from './info.js';
import { createNet } from './net.js';
import { createDemo } from './demo.js';
import { createLocalTools } from './local.js';
import { createChildChats } from './children.js';
import { createChatHistory } from './history.js';

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
const MODEL_PRESETS = { claude: ['opus', 'sonnet', 'haiku'], codex: [] };
const CHILD_MODEL_DEFAULTS = {};
const configs = {};
let repoPath = '';
let cloneParent = '';
let cloneBusy = false;
let githubRepos = [];
let githubPage = 0;
let githubLoading = false;
const act = {};
const warned = {};
const other = (id) => AGENTS.find((a) => a !== id);
const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));

const ui = { sel: null, hidden: false, demo: false, connected: false };
const awaiting = { claude: new Set(), codex: new Set() };
const bootAt = Date.now();

// Lite mode: text only, no 3D scene (see scene-lite.js). ?lite=0 / ?lite=1 override the saved choice.
const liteParam = new URLSearchParams(location.search).get('lite');
if (liteParam !== null) localStorage.setItem('tandem:lite', liteParam !== '0');
const lite = localStorage.getItem('tandem:lite') === 'true';
document.body.classList.toggle('lite', lite);
const themeParam = new URLSearchParams(location.search).get('theme');
if (themeParam === 'space' || themeParam === 'forest') localStorage.setItem('tandem:theme', themeParam);
const theme = localStorage.getItem('tandem:theme') === 'forest' ? 'forest' : 'space';
document.body.dataset.theme = theme;
const { createScene } = await (lite
  ? import('./scene-lite.js')
  : theme === 'forest'
    ? import('./scene-forest.js')
    : import('./scene.js'));
const scene = createScene($('#stage'));
let net = null;
let demo = null;
let localTools = null;
let folderPicker = null;
let childChats = null;
const chatHistory = createChatHistory({ send: (msg) => net?.send(msg), connected: () => !!net?.open && !ui.demo, getRepo: () => repoPath, getName: (id) => NAMES[id], notify: (text) => showNotice(text) });

// ---------------------------------------------------------------- panels
const info = new InfoPanel($('#right'), { onSelect: (id) => select(id) });

const panels = {};
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
      effort: (effort) => (ui.demo ? onMeta(id, { effort }) : net.send({ t: 'effort', agent: id, effort })),
      model: (model) => (ui.demo ? onMeta(id, { modelPref: model || null, model: model || (id === 'claude' ? 'claude-opus-5-5' : null) }) : net.send({ t: 'model', agent: id, model })),
      send: (text, attachments) => (ui.demo ? demo.respond(id, text) : net.send({ t: 'send', agent: id, text, attachments })),
      stop: () => net.send({ t: 'stop', agent: id }),
      mode: (mode) => (ui.demo ? onMeta(id, { mode }) : net.send({ t: 'mode', agent: id, mode })),
      newChat: () => (ui.demo ? (panels[id].reset([]), onMeta(id, { busy: false })) : net.send({ t: 'newchat', agent: id })),
      history: () => chatHistory.open(id),
      approve: (requestId, allow) => net.send({ t: 'approve', agent: id, requestId, allow }),
      forward: (text) => forward(id, text),
      focus: () => select(ui.sel === id ? null : id),
    },
  });
}

for (const id of AGENTS) createPanel(id);
childChats = createChildChats({ panels, send: (m) => net?.send(m), selectParent: (id) => select(id), notice: (text) => showNotice(text), isDemo: () => ui.demo, models: () => MODEL_PRESETS, defaults: () => CHILD_MODEL_DEFAULTS, onChange: childActivity });

function reconcile(next) {
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
  renderAgentList();
  childChats?.mountParents();
}

// Subagent chats count toward their parent's planet: moons, heat, the sparkline, the label and the log.
const kidBusy = new Map();
function childActivity(id, chars = 0) {
  if (!panels[id]) return;
  const kids = childChats?.activity(id) || [];
  if (chars) act[id].chars += chars;
  for (const k of kids) {
    if (kidBusy.get(k.id) === k.busy) continue;
    if (kidBusy.has(k.id) || k.busy) info.log({ agent: id, kind: k.busy ? 'info' : k.status === 'failed' ? 'err' : 'ok', text: `${NAMES[k.provider] || k.provider} subagent ${k.busy ? 'started' : k.status === 'failed' ? 'failed' : 'finished'} › ${k.title.slice(0, 60)}` });
    kidBusy.set(k.id, k.busy);
  }
  info.setChildren(id, kids);
  syncScene(id);
  updateLabels();
}

function forward(from, text) {
  const choices = AGENTS.filter((a) => a !== from);
  if (!choices.length) return;
  const to = choices.length === 1 ? choices[0] : prompt(`Send review to agent ID: ${choices.join(', ')}`, choices[0]);
  if (!choices.includes(to)) return;
  const quoted = text.split('\n').map((l) => '> ' + l).join('\n');
  panels[to].setDraft(`${NAMES[from]} just said this. Review it critically: what is wrong, missing or risky?\n\n${quoted}`);
  scene.handoff(from, to);
  info.log({ agent: from, text: `handed a reply to ${NAMES[to]} for review`, kind: 'info' });
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
  const kids = childChats?.activity(id) || [];
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
  scene.setStatus(id, status(id));
}


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
  if (id && !panels[id]) return;
  childChats?.parentSelected(id);
  ui.sel = id || null;
  document.body.dataset.sel = ui.sel || '';
  for (const a of AGENTS) {
    panels[a].root.classList.toggle('on', a === ui.sel);
    panels[a].root.classList.toggle('collapsed', a !== ui.sel);
  }
  scene.setSelected(ui.sel);
  info.setSelected(ui.sel);
  if (ui.sel) setTimeout(() => { panels[ui.sel]?.focusInput(); panels[ui.sel]?.root.scrollIntoView({ block: 'nearest' }); }, 500);
  else document.activeElement?.blur?.();
}

function layout() {
  const vw = window.innerWidth;
  const lw = vw < 700 ? vw : clamp(340, vw * 0.30, 470);
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

scene.onPick((id) => id === 'sun' ? openWorkspace() : select(id && id !== ui.sel ? id : null));
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
    let [cls, text] = panels[a].state;
    const kids = (childChats?.activity(a) || []).filter((k) => k.busy);
    if (kids.length && (cls === 'ready' || cls === 'idle')) { cls = 'work'; text = `${kids.length} subagent${kids.length > 1 ? 's' : ''} working`; }
    else if (kids.length && cls === 'work') text += ` · ${kids.length} subagent${kids.length > 1 ? 's' : ''}`;
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
  if (theme === 'forest') return;
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
  if (repoPath && git.cwd && repoPath !== git.cwd) {
    localTools?.repoChanged();
    for (const id of AGENTS) { panels[id].ta.value = ''; panels[id].clearAttachments(); panels[id].autosize(); sessionStorage.removeItem(`tandem:draft:${id}`); }
  }
  $('#sl-repo').textContent = git.repo || 'codebase';
  $('#sl-git').textContent = git.branch ? `${git.branch} · ${git.changed ? git.changed + ' changed' : 'clean'}` : 'the codebase';
  $('#cwd').textContent = git.repo ? `…\\${git.repo}` : '';
  repoPath = git.cwd || repoPath;
  $('#cwd').title = repoPath;
  $('#repo-path').value = repoPath;
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
      if (!localStorage.getItem('tandem:setup-complete')) setTimeout(() => { if (!document.querySelector('dialog[open]')) $('#setup-dialog').showModal(); }, 250);
      setGit(data.git);
      if (data.local) localTools?.receive({ t: 'localstate', ...data.local });
      if (data.local?.childModelDefaults) { Object.assign(CHILD_MODEL_DEFAULTS, data.local.childModelDefaults); childChats?.setDefaults(); }
      cloneParent = data.cloneParent || '';
      if (data.clone) setCloneStatus(data.clone);
      reconcile(data.agents);
      for (const [provider, models] of Object.entries(data.models || {})) {
        MODEL_PRESETS[provider] = models;
        for (const id of AGENTS) if (configs[id]?.provider === provider) panels[id].setModels(models);
      }
    } else if (kind === 'open') {
      ui.connected = true;
      setConn('ok', 'live · localhost');
      setOffline(false);
      childChats?.setOffline(false);
      info.log({ agent: 'claude', kind: 'info', text: 'connected to the Tandem server' });
    } else if (kind === 'closed') {
      githubLoading = false;
      $('#load-github-repos').disabled = $('#more-github-repos').disabled = false;
      ui.connected = false;
      setConn('bad', ui.demo ? 'demo' : 'offline');
      setOffline(true);
      childChats?.setOffline(true);
    }
  },
  onMessage(msg) {
    if (ui.demo) return;
    if (chatHistory.receive(msg)) return;
    if (childChats?.receive(msg)) return;
    if (folderPicker?.receive(msg)) return;
    if (localTools?.receive(msg)) return;
    if (msg.t === 'notice') { showNotice(msg.text); return; }
    if (msg.t === 'githubrepos') { receiveGithubRepos(msg); return; }
    if (msg.t === 'apimodels') {
      const status = $('#api-model-status');
      if (msg.error) { status.textContent = msg.error; return; }
      const list = $('#api-model-options'); list.replaceChildren();
      for (const model of msg.models || []) { const option = document.createElement('option'); option.value = model; list.append(option); }
      status.textContent = `${msg.models.length} model${msg.models.length === 1 ? '' : 's'} found`;
      if (!$('#agent-form [name="model"]').value && msg.models[0]) $('#agent-form [name="model"]').value = msg.models[0];
      return;
    }
    if (msg.t === 'clone') { setCloneStatus(msg); return; }
    if (msg.t === 'snapshot') {
      if (msg.configs) reconcile(msg.configs);
      childChats?.replace(msg.children || []);
      if (!(msg.clone?.busy ?? cloneBusy)) $('#workspace-dialog').close();
      if (msg.clone) setCloneStatus(msg.clone);
      info.clearLog();
      toolSeen.clear();
      for (const a of AGENTS) {
        const snap = msg.agents[a];
        if (!snap) continue;
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
  if (on && (AGENTS.length !== 2 || AGENTS.some((a) => !['claude', 'codex'].includes(a)))) { showNotice('Demo is available with the original Claude and Codex planets.'); return; }
  ui.demo = on;
  childChats.close();
  childChats.replace(on ? [{ id: 'demo-child', parentId: 'codex', provider: 'claude', title: 'Review the settings change', updatedAt: Date.now(),
    source: 'tandem', meta: { available: true, busy: false, status: 'completed', mode: 'plan', resumable: true, model: 'sonnet' },
    events: [{ k: 'user', id: 'demo-child-task', text: 'Review the settings change and check that saved preferences survive a reload.' },
      { k: 'tool', id: 'demo-child-tool', name: 'Read', summary: 'src/settings.js', status: 'done', output: 'Reviewed the settings hook and local storage fallback.' },
      { k: 'msg', id: 'demo-child-reply', text: 'The theme preference is saved correctly. One case needs attention: when local storage is unavailable, the settings hook should fall back to the default theme.\n\nI sent the finding back to the main task.', done: true }] }] : []);
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
let noticeTimer;
function showNotice(text) {
  $('#notice').textContent = text; $('#notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('#notice').hidden = true, 9000);
}
function openWorkspace() {
  if (ui.demo) { showNotice('Leave demo mode to change the workspace.'); return; }
  $('#repo-path').value = repoPath;
  renderAgentList();
  localTools.openWorkspace();
  $('#workspace-dialog').showModal();
}
function openWorkspaceTab(tab) {
  openWorkspace();
  document.querySelector(`[data-workspace-tab="${tab}"]`)?.click();
}
function setCloneStatus(state) {
  cloneBusy = !!state.busy;
  $('#clone-status').textContent = state.text || '';
  $('#clone-status').classList.toggle('clone-error', state.ok === false);
  document.querySelectorAll('#clone-submit, #repo-form button, #clone-source, #clone-url, #clone-destination').forEach(el => { el.disabled = cloneBusy; });
  $('#clone-submit').textContent = cloneBusy ? 'Cloning…' : 'Clone and open';
  for (const id of AGENTS) panels[id].setWorkspaceBusy(cloneBusy);
  $('#agent-form button[type="submit"]').disabled = cloneBusy;
  renderGithubRepos();
  if (state.ok) showNotice(state.text);
  if (state.ok === false && !$('#workspace-dialog').open) showNotice(state.text);
}
function suggestCloneDestination() {
  const input = $('#clone-destination');
  if (input.value && input.value !== input.dataset.suggested) return;
  const raw = $('#clone-url').value.trim().replace(/\/$/, '').split('/').at(-1)?.replace(/\.git$/, '');
  if (!raw || !/^[A-Za-z0-9_.-]+$/.test(raw) || !cloneParent) return;
  const separator = cloneParent.includes('\\') ? '\\' : '/';
  input.value = cloneParent.replace(/[\\/]+$/, '') + separator + raw;
  input.dataset.suggested = input.value;
}
function loadGithubRepos(page = 1) {
  if (!net.open) return showNotice('Connect to the Tandem server first.');
  if (githubLoading) return;
  githubLoading = true;
  $('#github-account').textContent = 'Loading…';
  $('#load-github-repos').disabled = $('#more-github-repos').disabled = true;
  net.send({ t: 'githubrepos', page });
}
function receiveGithubRepos(msg) {
  githubLoading = false;
  $('#load-github-repos').disabled = $('#more-github-repos').disabled = false;
  if (msg.error) { $('#github-account').textContent = msg.error; return; }
  githubPage = msg.page;
  githubRepos = msg.page === 1 ? msg.repos : [...githubRepos, ...msg.repos];
  $('#github-account').textContent = `Signed in as ${msg.login}`;
  $('#more-github-repos').hidden = !msg.hasMore;
  renderGithubRepos();
}
function renderGithubRepos() {
  const query = $('#github-search').value.trim().toLowerCase();
  const list = $('#github-repos'); list.replaceChildren();
  const rows = githubRepos.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(query));
  for (const repo of rows) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'github-repo';
    const title = document.createElement('b'); title.textContent = repo.name;
    const visibility = document.createElement('span'); visibility.textContent = `${repo.private ? 'Private' : 'Public'}${repo.archived ? ' · archived' : ''}`;
    const description = document.createElement('small'); description.textContent = repo.description;
    button.append(title, visibility, description);
    button.classList.toggle('selected', $('#clone-url').value === repo.url);
    button.disabled = cloneBusy;
    button.addEventListener('click', () => { $('#clone-url').value = repo.url; suggestCloneDestination(); renderGithubRepos(); });
    list.append(button);
  }
  if (!rows.length) { const empty = document.createElement('p'); empty.textContent = githubRepos.length ? 'No matching repositories.' : 'No repositories loaded yet.'; list.append(empty); }
}
$('#clone-source').addEventListener('change', () => {
  $('#github-browser').hidden = $('#clone-source').value !== 'account';
  if ($('#clone-source').value === 'account' && !githubRepos.length) loadGithubRepos();
});
$('#load-github-repos').addEventListener('click', () => loadGithubRepos());
$('#more-github-repos').addEventListener('click', () => loadGithubRepos(githubPage + 1));
$('#github-search').addEventListener('input', renderGithubRepos);
$('#clone-url').addEventListener('input', suggestCloneDestination);
$('#clone-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!net.open) return showNotice('Connect to the server first.');
  if (cloneBusy) return;
  if (AGENTS.some((id) => panels[id].meta.busy)) { $('#clone-status').textContent = 'Stop running agents before cloning and opening a repository.'; return; }
  net.send({ t: 'clone', source: $('#clone-source').value, url: $('#clone-url').value.trim(), destination: $('#clone-destination').value.trim() });
});
function renderAgentList() {
  const list = $('#agent-list'); list.replaceChildren();
  for (const id of AGENTS) {
    const row = document.createElement('div'); row.className = 'settings-agent';
    const label = document.createElement('span');
    label.textContent = `${NAMES[id]} · ${configs[id]?.provider || id} · ${panels[id].state[1]}`;
    label.style.color = AGENT_LOOK[id].hex;
    const remove = document.createElement('button'); remove.textContent = 'Remove';
    remove.disabled = AGENTS.length < 2 || !!panels[id].meta.busy;
    remove.addEventListener('click', () => { if (confirm(`Remove ${NAMES[id]} and its conversation? Export first if you need a copy.`)) net.send({ t: 'removeagent', agent: id }); });
    row.append(label, remove); list.append(row);
  }
}
$('#btn-workspace').addEventListener('click', openWorkspace);
$('#btn-setup').addEventListener('click', () => $('#setup-dialog').showModal());
$('#close-setup').addEventListener('click', () => $('#setup-dialog').close());
$('#finish-setup').addEventListener('click', () => { localStorage.setItem('tandem:setup-complete', '1'); $('#setup-dialog').close(); showNotice('Setup saved. You can reopen it anytime from Set up.'); });
document.querySelectorAll('[data-setup]').forEach((button) => button.addEventListener('click', () => {
  const action = button.dataset.setup;
  $('#setup-dialog').close();
  if (action === 'folder') return openWorkspaceTab('local');
  if (action === 'clone' || action === 'github') {
    openWorkspaceTab('clone');
    if (action === 'github') { $('#clone-source').value = 'account'; $('#clone-source').dispatchEvent(new Event('change')); }
    return;
  }
  if (action === 'agents') return openWorkspaceTab('agents');
  if (action === 'profile') return $('#btn-profile').click();
  showNotice('New project setup is the next Tandem step. For now, choose a new empty folder with Open a folder.');
}));
$('#close-workspace').addEventListener('click', () => $('#workspace-dialog').close());
$('.sl').style.pointerEvents = 'auto';
$('.sl').style.cursor = 'pointer';
$('.sl').title = 'Change working repository or manage agents';
$('.sl').addEventListener('click', openWorkspace);
$('#repo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!net.open) return showNotice('Connect to the server first.');
  net.send({ t: 'repo', cwd: $('#repo-path').value.trim() });
});
$('#agent-provider').addEventListener('change', () => {
  const api = $('#agent-provider').value === 'api';
  $('#api-fields').hidden = !api;
  $('#agent-form [name="model"]').required = api;
  $('#agent-form [name="endpoint"]').required = api;
});
$('#detect-api-models').addEventListener('click', () => {
  if (!net.open) return showNotice('Connect to the server first.');
  $('#api-model-status').textContent = 'Checking…';
  net.send({ t: 'apimodels', endpoint: $('#agent-form [name="endpoint"]').value.trim(), keyEnv: $('#agent-form [name="keyEnv"]').value.trim() });
});
$('#agent-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!net.open) return showNotice('Connect to the server first.');
  const config = Object.fromEntries(new FormData(e.target));
  net.send({ t: 'addagent', config });
});
$('#btn-export').addEventListener('click', () => {
  const lines = [`# Tandem session`, ``, `Repository: ${repoPath}`, `Exported: ${new Date().toISOString()}`, ``];
  for (const id of AGENTS) {
    lines.push(`## ${NAMES[id]}`, `Model: ${panels[id].meta.modelPref || panels[id].meta.model || 'CLI default'} · Effort: ${panels[id].meta.effort || 'default'}`, ``);
    for (const en of panels[id].entries.values()) {
      if (en.el.classList.contains('user')) lines.push(`### You`, en.el.querySelector('.bub').textContent, ...(en.attachments || []).map(a => `Attached image: ${a.name || 'Image'} (.tandem/uploads/${a.id})`), ``);
      else if (en.el.classList.contains('bot')) lines.push(`### ${NAMES[id]}`, en.text || '', ``);
      else if (en.data) lines.push(`- ${en.data.name}: ${en.data.summary || ''} (${en.data.status})`);
      else if (en.el.classList.contains('err')) lines.push(`Error: ${en.el.textContent}`, ``);
    }
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
  const a = document.createElement('a'); a.href = url; a.download = `tandem-${new Date().toISOString().slice(0, 10)}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
let eco = localStorage.getItem('tandem:eco') === 'true';
function setEco(on) { eco = on; scene.setEco(on); $('#btn-eco').classList.toggle('on', on); localStorage.setItem('tandem:eco', on); }
$('#btn-eco').addEventListener('click', () => setEco(!eco));
$('#btn-lite').classList.toggle('on', lite);
$('#btn-lite').addEventListener('click', () => { localStorage.setItem('tandem:lite', !lite); location.reload(); });
$('#btn-theme').textContent = theme === 'forest' ? 'Theme: Solar system' : 'Theme: Sunset cats';
$('#btn-theme').addEventListener('click', () => {
  localStorage.setItem('tandem:theme', theme === 'forest' ? 'space' : 'forest');
  location.reload();
});
setEco(eco);
const SKY = ['ship', 'meteor', 'comet', 'asteroid'];
let skyN = 0;
$('#btn-overview').addEventListener('click', () => { scene.setTopDown(true); select(null); });
$('#btn-ui').addEventListener('click', () => setHidden(!ui.hidden));
$('#btn-demo').addEventListener('click', () => setDemo(!ui.demo));
$('#btn-sky').addEventListener('click', () => scene.sky(SKY[skyN++ % SKY.length]));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('dialog[open]')) return;
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
folderPicker = createFolderPicker({ send: msg => net.send(msg), connected: () => net.open && !ui.demo, getRepo: () => repoPath, notify: showNotice });
document.querySelectorAll('[data-workspace-tab]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-workspace-tab]').forEach(b => { b.classList.toggle('on', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  document.querySelectorAll('[data-workspace-page]').forEach(page => { page.hidden = page.dataset.workspacePage !== button.dataset.workspaceTab; });
}));
document.querySelectorAll('.toolbar-menu button').forEach(button => button.addEventListener('click', () => { button.closest('details').open = false; }));
document.addEventListener('click', e => { const menu = document.querySelector('.toolbar-more'); if (!menu.contains(e.target)) menu.open = false; });
localTools = createLocalTools({
  send: (msg) => net.send(msg), connected: () => net.open && !ui.demo, getRepo: () => repoPath,
  getAgents: () => AGENTS.map((id) => ({ id, name: NAMES[id] })), notify: showNotice,
  setDraft(id, text) {
    if (!panels[id]) return false;
    const draft = [panels[id].ta.value, text].filter(Boolean).join('\n\n');
    if (draft.length > 40000) { showNotice('The combined draft exceeds 40,000 characters. Shorten it first.'); return false; }
    panels[id].setDraft(draft); select(id); return true;
  },
});
layout();
scene.setTopDown(true);
select(null);
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
