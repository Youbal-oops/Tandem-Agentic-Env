// A subagent in its own window: just its conversation, over the same server connection. There is no 3D
// scene here, so opening it costs a chat panel and nothing else.

import '@fontsource/playfair-display/400-italic.css';
import '@fontsource/inter/400.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './style.css';
import './workspace.css';
import './styles/features.css';
import './children.css';
import './styles/child-window.css';
import { ChatPanel } from './chat.js';
import { createNet } from './net.js';

const MODES = {
  claude: [{ id: 'plan', label: 'Plan', hint: 'Read-only' }, { id: 'ask', label: 'Ask', hint: 'Ask before changes' }, { id: 'edit', label: 'Edit', hint: 'Allow file edits' }, { id: 'auto', label: 'Auto', hint: 'Claude checks actions' }],
  codex: [{ id: 'read', label: 'Read-only', hint: 'Inspect the repository' }, { id: 'edit', label: 'Edit', hint: 'Allow workspace changes' }],
};
const $ = (s) => document.querySelector(s);
const id = new URLSearchParams(location.search).get('id') || '';
const providerName = (p) => (p === 'claude' ? 'Claude' : 'Codex');
let record = null;
let panel = null;
let models = {};
let names = {};
let offline = true;
const signatures = new Map();

const label = (c) => (c.meta.external ? 'Working with Claude' : c.meta.busy ? (c.meta.awaiting ? 'Needs approval' : 'Working') : c.meta.status === 'failed' ? 'Failed' : c.meta.status === 'interrupted' ? 'Interrupted' : 'Ready');
const say = (text) => { $('#cw-note').textContent = text || ''; };

function command(action, data = {}) {
  if (!net.open) return say('Not connected to Tandem.');
  net.send({ t: 'child-action', id, action, ...data });
}

function build(c) {
  const root = document.createElement('section');
  $('#cw-chat').replaceChildren(root);
  const p = new ChatPanel(root, { id: c.id, name: providerName(c.provider), provider: c.provider, modes: MODES[c.provider], models: models[c.provider] || [], handlers: {
    send: (text, attachments) => command('send', { text, attachments }), stop: () => command('stop'),
    mode: (mode) => command('mode', { mode }), model: (model) => command('model', { model }), effort: (effort) => command('effort', { effort }),
    approve: (requestId, allow, answers) => command('approve', { requestId, allow, answers }), newChat() {}, focus() {},
    forward: () => say('To forward this to the main chat, use the main Tandem window.'),
  } });
  root.style.setProperty('--c', c.provider === 'claude' ? 'var(--claude)' : 'var(--codex)');
  root.classList.add('on');
  const row = root.querySelector('.a-row'); row.removeAttribute('role'); row.removeAttribute('tabindex'); row.removeAttribute('title');
  root.querySelector('.c-new').hidden = true;
  return p;
}

function render() {
  if (!record) {
    $('#cw-title').textContent = 'This subagent is not available';
    $('#cw-state').textContent = '';
    return;
  }
  const c = record;
  panel ||= build(c);
  for (const e of c.events || []) {
    const sig = JSON.stringify(e);
    if (signatures.get(e.id) === sig) continue;
    panel.apply(e, true); signatures.set(e.id, sig);
  }
  panel.setMeta(c.meta); panel.setOffline(offline);
  const locked = c.meta.external || c.meta.resumable === false;
  panel.setWorkspaceBusy(locked);
  panel.ta.disabled = offline || locked;
  if (locked) panel.ta.placeholder = c.meta.external ? 'Claude is running this task…' : 'This review has no saved conversation';
  panel.root.querySelector('.stop').disabled = offline || c.meta.external;
  $('#cw-title').textContent = `${providerName(c.provider)} · ${c.title}`;
  $('#cw-parent').textContent = `SUBAGENT OF ${String(names[c.parentId] || c.parentId).toUpperCase()}`;
  $('#cw-state').textContent = label(c);
  $('#cw-state').dataset.state = c.meta.busy ? 'busy' : c.meta.status || '';
  document.title = `${label(c)} · ${providerName(c.provider)} subagent · Tandem`;
}

function applyEvent(m) {
  if (!record || m.id !== record.id) return;
  const events = record.events;
  const index = events.findIndex((e) => e.id === m.ev.id);
  if (m.ev.k === 'delta') { if (index >= 0) events[index].text = (events[index].text || '') + m.ev.text; }
  else if (index >= 0) events[index] = { ...events[index], ...m.ev }; else events.push(m.ev);
  record.updatedAt = m.updatedAt;
  render();
}

const net = createNet({
  onStatus(kind, data) {
    if (kind === 'session') {
      models = data.models || {};
      names = Object.fromEntries((data.agents || []).map((a) => [a.id, a.name]));
    } else if (kind === 'open') { offline = false; say(''); render(); }
    else if (kind === 'closed') { offline = true; say('Disconnected from Tandem. Reconnecting…'); render(); }
  },
  onMessage(m) {
    if (m.t === 'snapshot') { record = (m.children || []).find((c) => c.id === id) || record; render(); }
    else if (m.t === 'children') { record = m.children.find((c) => c.id === id) || null; render(); }
    else if (m.t === 'child' && m.child.id === id) { record = m.child; render(); }
    else if (m.t === 'child-event') applyEvent(m);
    else if (m.t === 'notice') say(m.text);
  },
});

$('#cw-main').addEventListener('click', () => { try { window.opener?.focus(); } catch { /* the opener may be gone */ } });
net.connect();
