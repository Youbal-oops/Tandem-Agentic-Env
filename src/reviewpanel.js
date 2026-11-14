// The Review screen, in the side panel: every agent's changes since you last approved them, in one place.
// Left: each agent with its changed files. Right: what the agent said it did to the chosen file, then the diff itself
// with line numbers. You can approve an agent's batch, ask about a piece of a diff, or send back your own version of it.
// The numbers and diffs come from the server (server/review), which compares each agent's folder with a snapshot taken
// at your last approval, so they are counted the same way for every agent. This screen never writes to an agent's folder.

import { parseHunks } from './diff.js';

const $ = (s) => document.querySelector(s);
const MAX_ROWS = 4000; // rows of one file's diff drawn at once

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'style') node.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
}
const norm = (p) => String(p || '').replaceAll('\\', '/');
const sameFile = (changePath, file) => { const c = norm(changePath); const f = norm(file); return !!c && !!f && (c === f || c.endsWith('/' + f)); };
const counts = (added, removed) => [el('span', { class: 'a' }, `+${added || 0}`), ' ', el('span', { class: 'r' }, `−${removed || 0}`)];

export function createReviewPanel({ send, connected, isOpen, show, getColor, openInCode }) {
  let agents = []; // CLI agents only: [{ id, name }]
  const views = new Map(); // agent id -> the server's review of it
  const asked = new Set();
  const listeners = [];
  let selected = { agent: '', path: '' };
  let patch = { agent: '', file: '', text: '', error: '', loading: false };
  let request = 0;

  const say = (text) => { $('#rv-msg').textContent = text || ''; };
  const name = (id) => agents.find((a) => a.id === id)?.name || id;
  const refresh = (id) => { if (connected() && agents.some((a) => a.id === id)) send({ t: 'review', agent: id }); };
  function refreshAll() { for (const a of agents) refresh(a.id); }

  function loadPatch() {
    const view = views.get(selected.agent);
    if (!view || !selected.path || !view.list.some((f) => f.path === selected.path)) { patch = { agent: '', file: '', text: '', error: '', loading: false }; return; }
    patch = { agent: selected.agent, file: selected.path, text: '', error: '', loading: true };
    send({ t: 'review-patch', agent: selected.agent, file: selected.path, request: ++request });
  }
  function choose(agent, path) {
    selected = { agent, path };
    loadPatch();
    render();
  }
  /** Keep the selection on something that still exists; with nothing chosen, take the first changed file. */
  function settle() {
    const view = views.get(selected.agent);
    if (view?.list.some((f) => f.path === selected.path)) return false;
    for (const a of agents) { const first = views.get(a.id)?.list[0]; if (first) { selected = { agent: a.id, path: first.path }; return true; } }
    selected = { agent: '', path: '' };
    return true;
  }

  // ------------------------------------------------------------ the list
  function renderList() {
    const list = $('#rv-list'); const top = list.scrollTop;
    list.replaceChildren();
    let files = 0, added = 0, removed = 0, held = 0;
    for (const a of agents) {
      const view = views.get(a.id);
      const group = el('section', { class: 'rv-agent' + (view?.held ? ' held' : ''), style: `--c:${getColor(a.id) || 'var(--mute)'}` });
      const sumA = view?.list.reduce((n, f) => n + (f.added || 0), 0) || 0;
      const sumR = view?.list.reduce((n, f) => n + (f.removed || 0), 0) || 0;
      files += view?.list.length || 0; added += sumA; removed += sumR; if (view?.held) held += 1;
      const has = !!view?.list.length;
      group.append(el('header', {}, el('i', { class: 'dot' }), el('b', {}, a.name),
        el('span', { class: 'count' }, has ? [`${view.list.length} file${view.list.length === 1 ? '' : 's'} `, ...counts(sumA, sumR)] : view ? 'no changes' : '…')));
      if (view?.held) group.append(el('p', { class: 'rv-held' }, `Waiting for your review: ${view.reason}. Its next task is held until you approve.`));
      if (view && view.limits?.enabled && has) {
        const pct = Math.min(100, Math.round((view.lines / Math.max(1, view.limits.maxLines)) * 100));
        group.append(el('div', { class: 'rv-meter', title: `${view.lines} of ${view.limits.maxLines} changed lines in this batch` }, el('u', { style: `width:${pct}%` })));
      }
      for (const f of view?.list || []) {
        const on = selected.agent === a.id && selected.path === f.path;
        const notes = view.changes.filter((c) => sameFile(c.file, f.path) && c.note).length;
        group.append(el('button', { type: 'button', class: 'rv-file' + (on ? ' on' : ''), title: f.path, on: { click: () => choose(a.id, f.path) } },
          el('span', { class: 'path' }, '‎' + f.path), notes ? el('span', { class: 'rv-notes', title: `${notes} note${notes === 1 ? '' : 's'} from ${a.name}` }, '✎') : null,
          el('span', { class: 'count' }, f.binary ? 'binary' : counts(f.added, f.removed))));
      }
      if (has || view?.held) {
        group.append(el('div', { class: 'rv-actions' },
          el('button', { type: 'button', title: 'Accept this batch; the next one starts from here', on: { click: () => { send({ t: 'review-approve', agent: a.id }); say(`Approved ${a.name}'s changes. Its next batch starts from here.`); } } }, 'Approve'),
          el('button', { type: 'button', class: 'primary', title: 'Approve, then tell the agent to carry on in small steps', on: { click: () => { send({ t: 'review-approve', agent: a.id, continue: true }); say(`Approved. ${a.name} was told to carry on in small steps.`); } } }, 'Approve & continue')));
      }
      list.append(group);
    }
    if (!agents.length) list.append(el('p', { class: 'rv-empty' }, 'Add a coding agent (Claude Code, Codex, Gemini or Antigravity) and its changes will show here.'));
    list.scrollTop = top;
    $('#rv-summary').textContent = !agents.length ? '' : files ? `${files} file${files === 1 ? '' : 's'} changed · +${added} −${removed}${held ? ` · ${held} waiting on you` : ''}` : 'Nothing to review';
  }

  // ------------------------------------------------------------ one file
  function hunkView(h) {
    const start = h.header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    let oldNo = start ? Number(start[1]) : 0, newNo = start ? Number(start[2]) : 0;
    const body = el('div', { class: 'rv-rows' });
    for (const r of h.rows) {
      const a = r.kind === 'add' ? '' : String(oldNo++), b = r.kind === 'del' ? '' : String(newNo++);
      body.append(el('div', { class: 'rv-row ' + r.kind }, el('span', { class: 'no' }, a), el('span', { class: 'no' }, b), el('span', { class: 'sign' }, r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''), el('span', { class: 'txt' }, r.text || ' ')));
    }
    const tools = el('div');
    const who = name(selected.agent);
    const open = (...nodes) => tools.replaceChildren(el('div', { class: 'rv-edit' }, ...nodes));
    function edit() {
      const original = h.rows.filter((r) => r.kind !== 'del').map((r) => r.text).join('\n');
      const area = el('textarea', { 'aria-label': 'Your version of this code', spellcheck: 'false' }); area.value = original;
      const note = el('input', { placeholder: 'Why? (optional)', maxlength: '1000', 'aria-label': 'Note for the agent' });
      open(el('p', {}, `Edit the code as you want it. This does not change any file: ${who} gets it and decides.`), area, el('div', { class: 'line' }, note,
        el('button', { type: 'button', class: 'primary', on: { click: () => {
          if (area.value === original) return say('You have not changed anything yet.');
          send({ t: 'review-propose', agent: selected.agent, kind: 'edit', file: selected.path, before: original, after: area.value, note: note.value });
          tools.replaceChildren(); say(`Sent your edit to ${who}. Nothing in its folder has changed; it will apply it or reply.`);
        } } }, `Send to ${who}`), el('button', { type: 'button', on: { click: () => tools.replaceChildren() } }, 'Cancel')));
    }
    function ask() {
      const q = el('input', { placeholder: 'Ask about this code, or ask for a different change', maxlength: '4000', 'aria-label': 'Your question' });
      const code = h.rows.map((r) => (r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  ') + r.text).join('\n');
      const go = () => {
        if (!q.value.trim()) return say('Write a question first.');
        send({ t: 'review-propose', agent: selected.agent, kind: 'ask', file: selected.path, code, question: q.value });
        tools.replaceChildren(); say(`Sent your question to ${who}. The answer appears in its chat.`);
      };
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      open(el('p', {}, 'This piece of the diff is attached to your message. The agent answers in its chat and will not edit unless you ask it to.'), el('div', { class: 'line' }, q,
        el('button', { type: 'button', class: 'primary', on: { click: go } }, `Ask ${who}`), el('button', { type: 'button', on: { click: () => tools.replaceChildren() } }, 'Cancel')));
      q.focus();
    }
    return el('section', { class: 'rv-hunk' },
      el('header', {}, el('span', { class: 'at' }, h.header.replace(/^@@ .*? @@ ?/, '') || `line ${start ? start[2] : ''}`),
        el('button', { type: 'button', on: { click: ask } }, 'Ask…'), el('button', { type: 'button', on: { click: edit } }, 'Suggest an edit…')),
      body, tools);
  }

  function renderDetail() {
    const box = $('#rv-detail'); box.replaceChildren();
    const view = views.get(selected.agent);
    const file = view?.list.find((f) => f.path === selected.path);
    if (!file) {
      const any = agents.some((a) => views.get(a.id)?.list.length);
      box.append(el('p', { class: 'rv-empty' }, any ? 'Choose a file on the left.' : agents.length ? 'No agent has changed anything since your last approval. When one does, its files, its own notes and the diff show here.' : ''));
      return;
    }
    const who = name(selected.agent);
    box.append(el('header', { class: 'rv-file-head', style: `--c:${getColor(selected.agent) || 'var(--mute)'}` },
      el('div', {}, el('b', {}, file.path), el('span', {}, el('i', { class: 'dot' }), ` ${who} · `, ...(file.binary ? ['binary file'] : counts(file.added, file.removed)))),
      el('button', { type: 'button', title: `Open this file from ${who}'s folder in the Code view`, on: { click: () => openInCode(selected.agent, file.path) } }, 'Open file')));
    const mine = view.changes.filter((c) => sameFile(c.file, selected.path));
    const noted = mine.filter((c) => c.note);
    if (noted.length) {
      const notes = el('div', { class: 'rv-said' }, el('h3', {}, `What ${who} said it did`));
      for (const c of noted) notes.append(el('p', {}, c.note, ' ', el('span', { class: 'count' }, counts(c.added, c.removed))));
      box.append(notes);
    } else if (mine.length || view.changes.length) {
      box.append(el('p', { class: 'rv-hint' }, `${who} gave no explanation for this file (it may have been changed by a command, or this agent reports file names only).`));
    }
    if (patch.agent !== selected.agent || patch.file !== selected.path || patch.loading) { box.append(el('p', { class: 'rv-empty' }, 'Loading the diff…')); return; }
    if (patch.error) { box.append(el('p', { class: 'rv-empty' }, patch.error)); return; }
    const hunks = parseHunks(patch.text);
    if (!hunks.length) { box.append(el('p', { class: 'rv-empty' }, 'No line changes to show (a binary or empty file).')); return; }
    let rows = 0;
    for (const h of hunks) {
      if (rows > MAX_ROWS) { box.append(el('p', { class: 'rv-hint' }, 'This diff is very long. The rest is not shown here: use Open file, or VS Code.')); break; }
      rows += h.rows.length;
      box.append(hunkView(h));
    }
    box.scrollTop = 0;
  }

  let detailKey = '';
  function render() {
    if (!isOpen()) return;
    renderList();
    // Redraw the diff only when what it shows changed, so an open "Ask…" box is not wiped by another agent's update.
    const key = `${selected.agent}\n${selected.path}\n${patch.loading}\n${patch.error}\n${patch.text.length}\n${views.get(selected.agent)?.changes.length || 0}`;
    if (key !== detailKey) { detailKey = key; renderDetail(); }
  }

  $('#rv-refresh').addEventListener('click', () => { say(''); refreshAll(); if (selected.path) loadPatch(); render(); });

  return {
    /** The side panel started showing this screen. */
    shown() { detailKey = ''; refreshAll(); if (settle() || (selected.path && patch.file !== selected.path)) loadPatch(); render(); },
    setAgents(list) {
      agents = (list || []).filter((a) => a.provider !== 'api').map((a) => ({ id: a.id, name: a.name })); // API chats cannot change files
      for (const id of [...views.keys()]) if (!agents.some((a) => a.id === id)) views.delete(id);
      for (const a of agents) if (!asked.has(a.id) && connected()) { asked.add(a.id); refresh(a.id); }
      render();
    },
    /** The server became reachable: ask for every agent's state. */
    online() { for (const a of agents) { asked.add(a.id); refresh(a.id); } },
    repoChanged() { views.clear(); asked.clear(); selected = { agent: '', path: '' }; patch = { agent: '', file: '', text: '', error: '', loading: false }; detailKey = ''; render(); },
    refresh,
    /** What is waiting for review from one agent: { files, added, removed, held, list } or null. */
    get(id) {
      const v = views.get(id);
      return v ? { files: v.list.length, added: v.list.reduce((n, f) => n + (f.added || 0), 0), removed: v.list.reduce((n, f) => n + (f.removed || 0), 0), held: !!v.held, list: v.list } : null;
    },
    /** Call `fn(agentId)` whenever an agent's review state arrives. */
    onChange(fn) { listeners.push(fn); },
    /** Open the Review screen on one agent's file (or its first changed file). */
    open(agent, path) {
      const view = views.get(agent);
      selected = { agent, path: path || view?.list[0]?.path || '' };
      show();
      loadPatch();
      render();
    },
    receive(msg) {
      if (msg.t === 'review' && msg.review) {
        const id = msg.review.agent;
        if (agents.some((a) => a.id === id)) {
          views.set(id, msg.review);
          if (isOpen()) { if (settle() || id === selected.agent) loadPatch(); render(); }
          for (const fn of listeners) fn(id);
        }
        return false; // Settings also listens, for the "held" badge
      }
      if (msg.t === 'review-patch') {
        if (msg.request === request && msg.agent === selected.agent) { patch = { agent: msg.agent, file: msg.file || '', text: msg.text || '', error: msg.error || '', loading: false }; render(); }
        return true;
      }
      return false;
    },
  };
}
