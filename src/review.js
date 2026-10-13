// The review window: a pop-out page that shows what an agent changed since your last approval, with the
// agent's own note on each change. Edits and questions made here are sent to the agent as messages; this
// page never writes to the agent's folder. Everything from the server is rendered as text, never as HTML.

import { createNet } from './net.js';
import { parseHunks } from './diff.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let agent = params.get('agent') || '';
let configs = [];
let review = null;
let selected = '';
let request = 0;
let patchState = { file: '', text: '', error: '' };

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
}
const norm = (p) => String(p || '').replaceAll('\\', '/');
const sameFile = (changePath, file) => { const c = norm(changePath); const f = norm(file); return !!c && !!f && (c === f || c.endsWith('/' + f)); };
const say = (text) => { $('#status').textContent = text || ''; };
const name = () => configs.find((c) => c.id === agent)?.name || agent;

const net = createNet({
  onStatus(kind, data) {
    if (kind === 'session') {
      configs = (data.agents || []).filter((c) => c.provider !== 'api');
      if (!configs.some((c) => c.id === agent)) agent = configs[0]?.id || '';
      const select = $('#agent'); select.replaceChildren();
      for (const c of configs) select.append(el('option', { value: c.id }, c.name));
      select.value = agent;
    } else if (kind === 'open') { say(''); load(); }
    else if (kind === 'closed') say('Disconnected from Tandem. Reconnecting…');
  },
  onMessage(msg) {
    if (msg.t === 'review' && msg.review?.agent === agent) { review = msg.review; render(); if (selected || review.list.length) loadPatch(); }
    else if (msg.t === 'review-patch' && msg.request === request && msg.agent === agent) {
      patchState = { file: msg.file || '', text: msg.text || '', error: msg.error || '' };
      renderDetail();
    } else if (msg.t === 'notice') say(msg.text);
  },
});

function load() {
  if (!agent) return renderNone();
  net.send({ t: 'review', agent });
}
function loadPatch() {
  if (!review) return;
  if (!review.list.some((f) => f.path === selected)) selected = review.list[0]?.path || '';
  if (!selected) { patchState = { file: '', text: '', error: '' }; renderDetail(); return; }
  net.send({ t: 'review-patch', agent, file: selected, request: ++request });
}

function renderNone() {
  $('#detail').replaceChildren(el('p', { class: 'empty' }, 'There is no Claude or Codex CLI agent to review.'));
}

function render() {
  const r = review;
  const meter = $('#meter');
  const max = r.limits.maxLines;
  meter.className = 'meter' + (r.held ? ' held' : '');
  meter.replaceChildren(
    el('div', {}, r.limits.enabled ? `${r.lines} / ${max} lines · ${r.files} / ${r.limits.maxFiles} files` : `${r.lines} lines · ${r.files} files · limit off`),
    el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${r.limits.enabled ? Math.min(100, Math.round((r.lines / Math.max(1, max)) * 100)) : 0}%` })),
  );
  const banner = $('#banner');
  banner.hidden = !r.held;
  banner.textContent = r.held ? `${name()} needs your review: ${r.reason}. Read the changes, edit or ask about them, then approve. Its next task waits until you do.` : '';
  $('#approve').disabled = $('#approve-go').disabled = !r.list.length && !r.held;
  const files = $('#files'); files.replaceChildren();
  if (!r.list.length) files.append(el('p', { class: 'empty' }, 'No changed files yet.'));
  for (const f of r.list) {
    files.append(el('button', { type: 'button', class: f.path === selected ? 'on' : '', title: f.path, on: { click: () => { selected = f.path; render(); loadPatch(); } } },
      el('span', { class: 'path' }, '‎' + f.path),
      el('span', { class: 'count' }, f.binary ? 'binary' : [el('span', { class: 'a' }, `+${f.added}`), ' ', el('span', { class: 'r' }, `−${f.removed}`)])));
  }
  renderDetail();
}

function renderDetail() {
  const box = $('#detail'); box.replaceChildren();
  if (!review) return;
  if (!selected) {
    box.append(el('p', { class: 'empty' }, review.list.length ? 'Choose a file.' : 'Nothing has changed since the last approval.'));
    return;
  }
  const mine = review.changes.filter((c) => sameFile(c.file, selected));
  box.append(el('h2', {}, `What ${name()} said it did`));
  if (!mine.length) box.append(el('p', { class: 'hint' }, 'No edit note was recorded for this file (it may have been changed by a command or by Codex, which reports file names only).'));
  for (const c of mine) {
    box.append(el('article', { class: 'card' },
      el('header', {}, el('strong', {}, c.status === 'done' ? 'Edit' : c.status), el('span', { class: 'count' }, el('span', { class: 'a' }, `+${c.added}`), ' ', el('span', { class: 'r' }, `−${c.removed}`))),
      el('p', { class: 'note' + (c.note ? '' : ' none') }, c.note || 'No explanation was given before this edit.'),
      c.old || c.new ? el('details', { class: 'snippet' }, el('summary', {}, 'Show this edit'),
        c.old ? el('pre', { class: 'code' }, '− ' + c.old) : null, c.new ? el('pre', { class: 'code' }, '+ ' + c.new) : null) : null));
  }
  box.append(el('h2', {}, `The file now vs. your last approval`));
  if (patchState.error) { box.append(el('p', { class: 'empty' }, patchState.error)); return; }
  if (patchState.file !== selected) { box.append(el('p', { class: 'empty' }, 'Loading diff…')); return; }
  const hunks = parseHunks(patchState.text);
  if (!hunks.length) box.append(el('p', { class: 'empty' }, 'No line changes to show (binary or empty file).'));
  hunks.forEach((h) => box.append(hunkView(h)));
}

function hunkView(h) {
  const wrap = el('section', { class: 'hunk' });
  const rows = h.rows.map((r) => el('span', { class: 'row ' + r.kind }, (r.kind === 'add' ? '+ ' : r.kind === 'del' ? '− ' : '  ') + r.text));
  const tools = el('div');
  const header = el('header', {}, el('span', { class: 'at' }, h.header.replace(/^@@ .*? @@ ?/, '') || h.header),
    el('button', { type: 'button', on: { click: () => editor() } }, 'Edit…'),
    el('button', { type: 'button', on: { click: () => asker() } }, 'Ask…'));
  wrap.append(header, ...rows, tools);

  function open(...nodes) { tools.replaceChildren(el('div', { class: 'editor' }, ...nodes)); }
  function editor() {
    const original = h.rows.filter((r) => r.kind !== 'del').map((r) => r.text).join('\n');
    const area = el('textarea', { 'aria-label': 'Your version of this code', spellcheck: 'false' }); area.value = original;
    const note = el('input', { placeholder: 'Why? (optional)', maxlength: '1000', 'aria-label': 'Note for the agent' });
    const send = el('button', { type: 'button', class: 'primary', on: { click: () => {
      if (area.value === original) return say('You have not changed anything yet.');
      net.send({ t: 'review-propose', agent, kind: 'edit', file: selected, before: original, after: area.value, note: note.value });
      tools.replaceChildren(); say(`Sent your edit to ${name()}. Nothing in its folder has changed; it will apply it or reply.`);
    } } }, `Send to ${name()}`);
    open(el('p', { class: 'hint' }, `Edit the code as you want it. This does not change any file: ${name()} gets it and decides.`), area, el('div', { class: 'line' }, note, send, el('button', { type: 'button', on: { click: () => tools.replaceChildren() } }, 'Cancel')));
  }
  function asker() {
    const q = el('input', { placeholder: 'Ask about this code, or ask for a different change', maxlength: '4000', 'aria-label': 'Your question' });
    const code = h.rows.map((r) => (r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  ') + r.text).join('\n');
    const send = el('button', { type: 'button', class: 'primary', on: { click: () => {
      if (!q.value.trim()) return say('Write a question first.');
      net.send({ t: 'review-propose', agent, kind: 'ask', file: selected, code, question: q.value });
      tools.replaceChildren(); say(`Sent your question to ${name()}. The answer appears in its chat.`);
    } } }, `Ask ${name()}`);
    open(el('p', { class: 'hint' }, 'The code above is attached to your message. The agent answers in its chat and will not edit unless you ask it to.'), el('div', { class: 'line' }, q, send, el('button', { type: 'button', on: { click: () => tools.replaceChildren() } }, 'Cancel')));
  }
  return wrap;
}

$('#agent').addEventListener('change', (e) => { agent = e.target.value; review = null; selected = ''; patchState = { file: '', text: '', error: '' }; $('#detail').replaceChildren(el('p', { class: 'empty' }, 'Loading…')); load(); });
$('#refresh').addEventListener('click', () => { say(''); load(); });
$('#approve').addEventListener('click', () => { net.send({ t: 'review-approve', agent }); say('Batch approved. The next one starts from here.'); });
$('#approve-go').addEventListener('click', () => { net.send({ t: 'review-approve', agent, continue: true }); say(`Approved. ${name()} was told to carry on in small steps.`); });

net.connect();
