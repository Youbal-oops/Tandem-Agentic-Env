// The Team chat: one place to hand out tasks. You describe a task; the server picks the agent and the model for its
// size (server/team.mjs), sends it to that agent's own chat, and says who got it and why. This view then follows that
// agent and shows how it ended. The list is kept per project in this browser; the agents' own chats hold the full work.

const $ = (s) => document.querySelector(s);
const KEEP = 40;
const STATE = { working: 'Working…', waiting: 'Needs your approval', done: 'Done', failed: 'Failed', sent: 'Sent' };
const TIER = { light: 'Light', standard: 'Standard', heavy: 'Heavy' };

export function createTeamChat(app) {
  const view = $('#team-view');
  const feed = $('#team-feed');
  const ta = $('#team-text');
  let entries = []; // { id, text, at, agent?, name?, modelLabel?, tier?, reason?, note?, state, result?, error? }
  let request = 0;
  const pending = new Map(); // request id -> entry waiting for the server's choice
  const watching = new Map(); // agent id -> the entry that agent is working on
  const counting = new Map(); // agent id -> the finished entry waiting for that agent's change count
  let auto = true; // Team is the screen you start on, until you open an agent's chat yourself

  const key = () => `tandem:team:${app.repoPath || ''}`;
  const save = () => { try { localStorage.setItem(key(), JSON.stringify(entries.slice(-KEEP))); } catch { /* the list just will not survive a reload */ } };
  function load() {
    try { const list = JSON.parse(localStorage.getItem(key()) || '[]'); entries = Array.isArray(list) ? list.filter((e) => e && typeof e.text === 'string') : []; } catch { entries = []; }
    // Work that was running when the page went away cannot be followed any more: its agent's chat has the outcome.
    for (const e of entries) if (e.state === 'working' || e.state === 'waiting' || e.state === 'assigning') e.state = 'sent';
    watching.clear(); pending.clear();
    render();
  }

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function card(e) {
    const box = el('div', `t-card${e.error ? ' err' : ''}`);
    box.dataset.state = e.state || '';
    if (e.error) { box.textContent = e.error; return box; }
    if (e.state === 'assigning') { box.textContent = e.progress || 'Choosing who does this…'; return box; }
    const head = el('div', 't-head');
    const dot = el('i', 'dot'); dot.style.setProperty('--c', app.panels[e.agent]?.row.style.getPropertyValue('--c') || '');
    head.append(dot, el('b', '', e.name || e.agent), el('span', 't-pill', e.modelLabel || 'default model'), el('span', `t-pill tier-${e.tier}`, TIER[e.tier] || ''), el('span', 't-state', STATE[e.state] || ''));
    box.append(head, el('p', 't-why', e.reason || ''));
    if (e.by) box.append(el('p', 't-by', e.by));
    if (e.note) box.append(el('p', 't-note', e.note));
    if (e.result) box.append(el('div', 't-result', e.result));
    if (e.changes?.files) {
      // What this agent now has waiting for review. Each file opens its diff in the Review screen.
      const c = e.changes;
      const row = el('div', 't-changes');
      const all = el('button', 't-rev', `Review ${c.files} changed file${c.files === 1 ? '' : 's'}  +${c.added} −${c.removed}`); all.type = 'button';
      all.addEventListener('click', () => app.review.open(e.agent));
      row.append(all);
      for (const f of c.list) {
        const b = el('button', 't-file', f.path.split('/').pop()); b.type = 'button'; b.title = `${f.path}  +${f.added} −${f.removed}`;
        b.addEventListener('click', () => app.review.open(e.agent, f.path));
        row.append(b);
      }
      if (c.files > c.list.length) row.append(el('span', 't-more', `+ ${c.files - c.list.length} more`));
      box.append(row);
    }
    if (app.panels[e.agent]) {
      const open = el('button', 't-open', `Open ${e.name}'s chat`); open.type = 'button';
      open.addEventListener('click', () => { hide(); app.select(e.agent); });
      box.append(open);
    }
    return box;
  }
  function render() {
    const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
    feed.querySelectorAll('.t-task, .t-card').forEach((n) => n.remove());
    for (const e of entries) {
      const task = el('div', 't-task'); task.append(el('div', 'bub', e.text));
      feed.append(task, card(e));
    }
    view.classList.toggle('empty', entries.length === 0);
    $('#team-clear').disabled = entries.length === 0;
    if (stick) feed.scrollTop = feed.scrollHeight;
  }
  const changed = () => { save(); render(); };

  function show() {
    view.hidden = false;
    document.body.classList.add('team-on');
    $('#btn-team').classList.add('on');
    autosize();
    requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; ta.focus({ preventScroll: true }); });
  }
  function hide(byUser = true) {
    if (byUser) auto = false;
    view.hidden = true;
    document.body.classList.remove('team-on');
    $('#btn-team').classList.remove('on');
  }
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px'; }
  const say = (text) => { $('#team-status').textContent = text || ''; };

  function submit() {
    const text = ta.value.trim();
    if (!text) return;
    if (app.ui.demo) return say('Turn off Demo to give real tasks.');
    if (!app.net?.open) return say('Not connected to Tandem.');
    const entry = { id: `${Date.now()}-${++request}`, text, at: Date.now(), state: 'assigning' };
    entries.push(entry);
    pending.set(request, entry);
    app.net.send({ t: 'team-send', request, text, agent: $('#team-agent').value || undefined, tier: $('#team-tier').value || undefined });
    ta.value = ''; say(''); autosize(); changed();
    feed.scrollTop = feed.scrollHeight;
  }

  $('#btn-team').addEventListener('click', show);
  $('#team-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  ta.addEventListener('input', autosize);
  $('#team-clear').addEventListener('click', () => { entries = entries.filter((e) => e.state === 'working' || e.state === 'waiting' || e.state === 'assigning'); changed(); });
  load();
  app.review?.onChange((agent) => {
    const entry = counting.get(agent);
    if (!entry) return;
    counting.delete(agent);
    const r = app.review.get(agent);
    entry.changes = r && r.files ? { files: r.files, added: r.added, removed: r.removed, list: r.list.slice(0, 6).map((f) => ({ path: f.path, added: f.added || 0, removed: f.removed || 0 })) } : null;
    changed();
  });

  return {
    show, hide,
    setAgents(list) {
      const select = $('#team-agent'); const before = select.value;
      select.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Any agent' }));
      for (const a of list || []) select.append(Object.assign(document.createElement('option'), { value: a.id, textContent: a.name }));
      select.value = [...select.options].some((o) => o.value === before) ? before : '';
      $('#btn-team').hidden = !(list || []).length;
      if (!(list || []).length) hide(false);
      else if (auto && view.hidden) show();
      render();
    },
    /** Another project was opened: it has its own list. */
    repoChanged() { queueMicrotask(load); },
    /** The server chose (or could not). */
    receive(msg) {
      if (msg.t !== 'team') return false;
      const entry = pending.get(msg.request);
      if (!entry) return true;
      if (msg.progress) { entry.progress = msg.progress; render(); return true; } // still deciding
      pending.delete(msg.request);
      delete entry.progress;
      if (msg.error) { entry.error = msg.error; entry.state = 'failed'; }
      else { Object.assign(entry, msg.assignment, { state: 'working' }); watching.set(entry.agent, entry); }
      changed();
      return true;
    },
    /** Follow the agent that got a task: its last words become the result when its turn ends. */
    onEvent(agent, ev) {
      const entry = watching.get(agent);
      if (!entry) return;
      if (ev.k === 'tool' && ev.status === 'awaiting' && entry.state !== 'waiting') { entry.state = 'waiting'; changed(); }
      else if (ev.k === 'tool' && ev.status !== 'awaiting' && entry.state === 'waiting') { entry.state = 'working'; changed(); }
      else if (ev.k === 'error') { entry.result = String(ev.text || '').slice(0, 1200); }
      else if (ev.k === 'turn') {
        const last = [...(app.panels[agent]?.entries.values() || [])].reverse().find((x) => x.text && !x.think);
        entry.state = ev.ok === false ? 'failed' : 'done';
        if (ev.ok !== false || !entry.result) entry.result = (last?.text || entry.result || '').trim().slice(0, 1200);
        watching.delete(agent);
        counting.set(agent, entry); // the server recounts this agent's changes when its turn ends
        app.review?.refresh(agent);
        changed();
      }
    },
  };
}
