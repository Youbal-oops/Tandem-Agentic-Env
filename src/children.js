import { ChatPanel } from './chat.js';
import './children.css';

const MODES = {
  claude: [{ id: 'plan', label: 'Plan', hint: 'Read-only' }, { id: 'ask', label: 'Ask', hint: 'Ask before changes' }, { id: 'edit', label: 'Edit', hint: 'Allow file edits' }, { id: 'auto', label: 'Auto', hint: 'Claude checks actions' }],
  codex: [{ id: 'read', label: 'Read-only', hint: 'Inspect the repository' }, { id: 'edit', label: 'Edit', hint: 'Allow workspace changes' }],
};
const name = (provider) => provider === 'claude' ? 'Claude' : 'Codex';
const color = (provider) => provider === 'claude' ? 'var(--claude)' : 'var(--codex)';

const EFFORTS = [['', 'Default effort'], ['low', 'Light'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']];
const lastEffort = (provider) => { try { return localStorage.getItem(`tandem:child-effort:${provider}`) || ''; } catch { return ''; } };

export function createChildChats({ panels, send, selectParent, notice, isDemo, models = () => ({}), defaults = () => ({}), onChange = () => {} }) {
  const records = new Map(), views = new Map(), parents = new Map(), seen = new Map();
  let active = null, parentId = null, offline = false;
  const drawer = document.createElement('aside');
  drawer.id = 'child-drawer'; drawer.hidden = true; drawer.setAttribute('aria-label', 'Attached child conversation');
  drawer.innerHTML = `<div class="kicker"><span>Attached <span class="dot">·</span> <span class="child-state">subagent</span></span><button class="child-close" aria-label="Close child panel">close ×</button></div>
    <h2 class="child-breadcrumb"></h2>
    <div class="child-switch" role="group" aria-label="Conversation"><button data-view="main">My chat</button><button data-view="child" aria-pressed="true">Subagent chat</button></div>
    <div class="child-picker-row"><select class="child-picker" aria-label="Choose a child task"></select><button class="child-new">+ Task</button></div>
    <p class="child-context"></p><div class="child-views"></div>
    <form class="child-form" hidden><h3>Give it a task</h3><p>The child gets its own conversation, attached to your main chat.</p><label>Agent<select name="provider"><option value="claude">Claude</option><option value="codex">Codex</option></select></label><label>Task<textarea name="task" required maxlength="40000" rows="6" placeholder="What should this agent work on?"></textarea></label><p>Starts in Edit mode in the current repository. You can change the mode in the child chat.</p><button type="submit">Start child task →</button></form>`;
  document.body.append(drawer);
  const $ = (s) => drawer.querySelector(s);
  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'Model';
  const modelSelect = document.createElement('select');
  modelSelect.name = 'model'; modelSelect.setAttribute('aria-label', 'Subagent model');
  modelLabel.append(modelSelect);
  const effortLabel = document.createElement('label');
  effortLabel.textContent = 'Reasoning';
  const effortSelect = document.createElement('select');
  effortSelect.name = 'effort'; effortSelect.setAttribute('aria-label', 'Subagent reasoning effort');
  effortLabel.append(effortSelect);
  $('.child-form [name="provider"]').closest('label').after(modelLabel);
  modelLabel.after(effortLabel);
  function renderModelOptions(provider) {
    const select = $('.child-form [name="model"]');
    const available = models()[provider] || [];
    select.replaceChildren();
    const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'CLI default'; select.append(defaultOption);
    for (const model of available) { const option = document.createElement('option'); option.value = model; option.textContent = model; select.append(option); }
    const custom = document.createElement('option'); custom.value = '__custom__'; custom.textContent = 'Custom model…'; select.append(custom);
    const last = defaults()[provider];
    if (last && [...select.options].some((option) => option.value === last)) select.value = last;
    const efforts = $('.child-form [name="effort"]');
    efforts.replaceChildren(...[...EFFORTS, ...(provider === 'claude' ? [['max', 'Max']] : [])].map(([value, text]) => Object.assign(document.createElement('option'), { value, textContent: text })));
    efforts.value = [...efforts.options].some((o) => o.value === lastEffort(provider)) ? lastEffort(provider) : '';
  }
  function childrenFor(id) { return [...records.values()].filter((c) => c.parentId === id); }
  function activity(id) { return childrenFor(id).map((c) => ({ id: c.id, provider: c.provider, title: c.title, busy: !!c.meta.busy, awaiting: !!c.meta.awaiting, status: c.meta.status, thinking: !!c.meta.stats?.thinking, moons: c.meta.stats?.tools?.running || [] })); }
  function label(c) { return c.meta.external ? 'Working with Claude' : c.meta.busy ? c.meta.awaiting ? 'Needs approval' : 'Working' : c.meta.status === 'failed' ? 'Failed' : c.meta.status === 'interrupted' ? 'Interrupted' : 'Ready'; }
  function markSeen(c) { seen.set(c.id, c.updatedAt); try { sessionStorage.setItem(`tandem:child-seen:${c.id}`, String(c.updatedAt)); } catch {} }
  function renderParents() {
    for (const [id, host] of parents) {
      const items = childrenFor(id);
      host.list.replaceChildren();
      host.sub.textContent = `Subagent chats${items.length ? ` · ${items.length}` : ''}`;
      host.main.setAttribute('aria-pressed', String(!active || parentId !== id));
      host.sub.setAttribute('aria-pressed', String(!!active && parentId === id));
      for (const c of items) {
        const b = document.createElement('button'); b.className = 'child-card'; b.style.setProperty('--c', color(c.provider));
        b.innerHTML = '<span class="child-dot"></span><span class="child-card-copy"><b></b><small></small></span><span class="child-unread" hidden>New</span><span class="child-arrow" aria-hidden="true">›</span>';
        b.querySelector('b').textContent = `${name(c.provider)} · ${c.title}`;
        b.querySelector('small').textContent = label(c);
        b.dataset.busy = String(c.meta.busy); b.setAttribute('aria-expanded', String(active === c.id)); b.setAttribute('aria-controls', 'child-drawer');
        b.setAttribute('aria-label', `Open ${name(c.provider)} task: ${c.title}`);
        b.querySelector('.child-unread').hidden = !(c.updatedAt > (seen.get(c.id) || 0)) || active === c.id;
        b.addEventListener('click', () => open(c.id)); host.list.append(b);
      }
    }
  }
  function mountParents() {
    for (const [id, p] of Object.entries(panels)) {
      if (parents.get(id)?.panel === p) continue;
      const host = document.createElement('div'); host.className = 'child-links';
      host.innerHTML = '<div class="child-switch" role="group" aria-label="Conversation"><button data-view="main" aria-pressed="true">My chat</button><button data-view="child" aria-pressed="false">Subagent chats</button><button class="child-add" aria-label="Start an attached child task">+</button></div><div class="child-list"></div>';
      p.root.querySelector('.a-body').insertBefore(host, p.root.querySelector('.feed-controls'));
      const main = host.querySelector('[data-view="main"]'), sub = host.querySelector('[data-view="child"]');
      main.addEventListener('click', () => { close(); selectParent(id); });
      sub.addEventListener('click', () => { const items = childrenFor(id); if (items.length) open(items.at(-1).id); else newTask(id); });
      host.querySelector('.child-add').addEventListener('click', () => newTask(id));
      parents.set(id, { panel: p, list: host.querySelector('.child-list'), main, sub });
    }
    for (const id of parents.keys()) if (!panels[id]) parents.delete(id);
    renderParents();
  }
  function command(c, action, data = {}) {
    if (isDemo()) { notice('This is a demo child chat. Turn off Demo to run a real task.'); return; }
    send({ t: 'child-action', id: c.id, action, ...data });
  }
  function view(c) {
    let v = views.get(c.id);
    if (!v) {
      const root = document.createElement('section'); root.hidden = true; $('.child-views').append(root);
      const panel = new ChatPanel(root, { id: c.id, name: name(c.provider), provider: c.provider, modes: MODES[c.provider], models: models()[c.provider] || [], handlers: {
        send: (text, attachments) => command(c, 'send', { text, attachments }), stop: () => command(c, 'stop'),
        mode: (mode) => command(c, 'mode', { mode }), model: (model) => command(c, 'model', { model }), effort: (effort) => command(c, 'effort', { effort }),
        approve: (requestId, allow, answers) => command(c, 'approve', { requestId, allow, answers }), newChat() {}, focus() {},
        forward: (text) => { const parent = panels[c.parentId]; if (!parent) return; parent.setDraft(`Follow-up from ${name(c.provider)} — ${c.title}:\n\n${text}`); close(); selectParent(c.parentId); },
      } });
      root.style.setProperty('--c', color(c.provider)); root.classList.add('on');
      const row = root.querySelector('.a-row'); row.removeAttribute('role'); row.removeAttribute('tabindex'); row.removeAttribute('title');
      root.querySelector('.c-new').hidden = true;
      v = { panel, signatures: new Map() }; views.set(c.id, v);
    }
    for (const e of c.events || []) {
      const sig = JSON.stringify(e);
      if (v.signatures.get(e.id) === sig) continue;
      v.panel.apply(e, true); v.signatures.set(e.id, sig);
    }
    v.panel.setMeta(c.meta); v.panel.setOffline(offline);
    const locked = c.meta.external || c.meta.resumable === false;
    v.panel.setWorkspaceBusy(locked);
    v.panel.ta.disabled = offline || locked;
    if (locked) v.panel.ta.placeholder = c.meta.external ? 'Claude is running this task…' : 'This review has no saved conversation';
    v.panel.root.querySelector('.stop').disabled = offline || c.meta.external;
    return v.panel;
  }
  function setTitle(parent, text, provider) {
    const h = $('.child-breadcrumb'), em = document.createElement('em');
    em.textContent = text; if (provider) em.style.color = color(provider);
    h.replaceChildren(`${panels[parent]?.name || 'Main chat'} › `, em);
  }
  function header(c) {
    setTitle(c.parentId, name(c.provider), c.provider); $('.child-state').textContent = label(c).toLowerCase();
    $('.child-context').textContent = c.meta.external ? 'Live plugin activity · You can reply when Claude finishes this task.' : `${c.title} · ${label(c)}`;
    const picker = $('.child-picker'); picker.replaceChildren();
    for (const sibling of childrenFor(c.parentId)) { const o = document.createElement('option'); o.value = sibling.id; o.textContent = `${name(sibling.provider)} · ${sibling.title}`; picker.append(o); }
    picker.value = c.id;
  }
  function show() { drawer.hidden = false; document.body.classList.add('child-open'); }
  function open(id) {
    const c = records.get(id); if (!c || !panels[c.parentId]) return;
    parentId = c.parentId; selectParent(parentId); active = id; show();
    $('.child-views').hidden = false;
    $('.child-form').hidden = true; $('.child-picker-row').hidden = false; $('.child-context').hidden = false;
    for (const [key, v] of views) v.panel.root.hidden = key !== id;
    const p = view(c); p.root.hidden = false; header(c); markSeen(c); renderParents();
    requestAnimationFrame(() => p.focusInput());
  }
  function close() {
    if (active && records.has(active)) markSeen(records.get(active));
    drawer.hidden = true; active = null; document.body.classList.remove('child-open'); renderParents();
  }
  function newTask(id) {
    parentId = id; selectParent(id); active = null; show();
    $('.child-views').hidden = true;
    for (const v of views.values()) v.panel.root.hidden = true;
    $('.child-form').hidden = false; $('.child-picker-row').hidden = true; $('.child-context').hidden = true;
    setTitle(id, 'New task'); $('.child-state').textContent = 'new task';
    const provider = $('.child-form [name="provider"]');
    provider.value = panels[id]?.name === 'Claude' ? 'codex' : 'claude';
    renderModelOptions(provider.value);
    $('.child-form textarea').focus();
  }
  function upsert(c) {
    if (!seen.has(c.id)) { try { seen.set(c.id, Number(sessionStorage.getItem(`tandem:child-seen:${c.id}`)) || 0); } catch {} }
    records.set(c.id, c);
    if (active === c.id) { const p = view(c); p.root.hidden = false; header(c); markSeen(c); }
    renderParents(); onChange(c.parentId);
  }
  function replace(items) {
    const ids = new Set(items.map((c) => c.id));
    for (const id of records.keys()) if (!ids.has(id)) { records.delete(id); views.get(id)?.panel.root.remove(); views.delete(id); if (active === id) close(); }
    items.forEach(upsert); mountParents();
    for (const [id, view] of views) {
      const child = records.get(id);
      if (child) view.panel.setModels(models()[child.provider] || []);
    }
    for (const id of Object.keys(panels)) onChange(id);
  }
  $('.child-close').addEventListener('click', close);
  $('[data-view="main"]').addEventListener('click', () => { close(); if (parentId) selectParent(parentId); });
  $('[data-view="child"]').addEventListener('click', () => active && views.get(active)?.panel.focusInput());
  $('.child-picker').addEventListener('change', (e) => open(e.target.value));
  $('.child-form [name="provider"]').addEventListener('change', (e) => renderModelOptions(e.target.value));
  $('.child-new').addEventListener('click', () => newTask(parentId));
  drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); panels[parentId]?.focusInput(); } });
  $('.child-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (offline || isDemo()) { notice(isDemo() ? 'Turn off Demo to start a real child task.' : 'Reconnect to start a task.'); return; }
    const form = new FormData(e.target);
    const provider = form.get('provider');
    let model = form.get('model');
    if (model === '__custom__') model = (prompt(`Model name for ${name(provider)}`, '') || '').trim();
    const effort = form.get('effort');
    try { localStorage.setItem(`tandem:child-effort:${provider}`, effort || ''); } catch {}
    send({ t: 'child-create', agent: parentId, provider, text: form.get('task'), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  });
  mountParents();
  return {
    mountParents, close, replace, activity,
    parentSelected(id) { if (!drawer.hidden && id !== parentId) close(); },
    setOffline(value) { offline = value; for (const c of records.values()) if (views.has(c.id)) view(c); },
    setDefaults() { if (!$('.child-form').hidden) renderModelOptions($('.child-form [name="provider"]').value); },
    receive(m) {
      if (m.t === 'children') { replace(m.children); return true; }
      if (m.t === 'child') { upsert(m.child); return true; }
      if (m.t === 'child-open') { open(m.id); $('.child-form textarea').value = ''; return true; }
      if (m.t === 'child-event') {
        const c = records.get(m.id); if (!c) return true;
        const index = c.events.findIndex((e) => e.id === m.ev.id);
        if (m.ev.k === 'delta') { if (index >= 0) c.events[index].text = (c.events[index].text || '') + m.ev.text; }
        else if (index >= 0) c.events[index] = { ...c.events[index], ...m.ev }; else c.events.push(m.ev);
        c.updatedAt = m.updatedAt; upsert(c);
        onChange(c.parentId, m.ev.k === 'delta' ? m.ev.text.length : m.ev.k === 'tool' ? 20 : 0); return true;
      }
      return false;
    },
  };
}
