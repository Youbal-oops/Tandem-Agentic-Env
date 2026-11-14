// The Team chat: one place to hand out tasks. You describe a task; the server picks the agent and the model for its
// size (server/team.mjs) and sends it to that agent. The agent's answer is shown right here as it streams in, and
// approvals it asks for can be answered here too, so you can stay in this chat. The agent's own chat keeps the
// full record (every tool call) if you want to look at it. This list is saved on the server for each repository
// (server/team-chat.mjs), so it is still here after a restart.

import { md } from './markdown.js';

const $ = (s) => document.querySelector(s);
const STATE = { held: 'Held', working: 'Working…', waiting: 'Needs your approval', done: 'Done', failed: 'Failed', sent: 'Sent' };
const TIER = { light: 'Light', standard: 'Standard', heavy: 'Heavy' };
const SAVE_ENTRIES = 30; // tasks sent to the server
const SAVE_RESULT = 24000; // characters of one answer sent to the server
const SAVE_TOTAL = 900000; // one message must stay under the socket's 1 MB limit
const ENDED = new Set(['done', 'failed', 'sent', 'asked']);
const STATE_HELD = 'held';
const RUN_LIVE = new Set(['running', 'summarizing']);
const TASK_STATE = { pending: 'Waiting', running: 'Working…', waiting: 'Needs your approval', done: 'Done', failed: 'Failed', skipped: 'Skipped', stopped: 'Stopped', blocked: 'Needs you' };
const RUN_STATE = { running: 'Running', summarizing: 'Writing the report…', done: 'Done', partial: 'Partly done', failed: 'Failed', stopped: 'Stopped' };

export function createTeamChat(app) {
  const view = $('#team-view');
  const feed = $('#team-feed');
  const ta = $('#team-text');
  let entries = []; // { id, text, at, agent?, name?, modelLabel?, tier?, reason?, by?, note?, state, result?, error?, steps?, changes? }
  let request = 0;
  let loadedFor = null; // the repository whose saved chat has been read: nothing is saved before that
  let saveTimer = null;
  const pending = new Map(); // request id -> entry waiting for the server's choice
  const watching = new Map(); // agent id -> the entry that agent is working on
  const counting = new Map(); // agent id -> the finished entry waiting for that agent's change count
  const live = new Map(); // entry id -> { order: [message ids], texts: { id: text }, tools: Set } while its agent works
  const runs = new Map(); // plan id -> the plan as the server last sent it (the coordinator runs plans on the server)
  const opened = new Set(); // `${plan id}:${task id}` of task rows the user opened or closed by hand
  const seenDone = new Set(); // finished tasks whose agent's changes were already looked up for Review
  const rows = new Map(); // entry id -> { task, card } elements
  const dirty = new Set();
  let frame = 0;
  let auto = true; // Team is the screen you start on, until you open an agent's chat yourself

  // ------------------------------------------------------------ saving and loading
  function persist() {
    const list = entries.slice(-SAVE_ENTRIES).map((e) => ({ ...e, result: e.result ? e.result.slice(0, SAVE_RESULT) : undefined, progress: undefined, approval: undefined, doing: undefined }));
    while (list.length > 1 && JSON.stringify(list).length > SAVE_TOTAL) list.shift();
    return list;
  }
  function saveNow() {
    clearTimeout(saveTimer);
    if (!app.net?.open || loadedFor !== app.repoPath || app.ui.demo) return;
    app.net.send({ t: 'team-save', cwd: app.repoPath, entries: persist() });
  }
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); };
  function load() {
    loadedFor = null;
    entries = []; watching.clear(); pending.clear(); counting.clear(); live.clear();
    renderAll();
    if (app.net?.open && app.repoPath) app.net.send({ t: 'team-load' });
  }

  // ------------------------------------------------------------ drawing
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; };

  /** One plan from the coordinator: what it understood, a row per task, and the report when they are all done. */
  function runCard(e, run) {
    const box = el('div', 't-card t-run'); box.dataset.state = run.status;
    const head = el('div', 't-head');
    const finished = run.tasks.filter((t) => t.state === 'done').length;
    const status = `${RUN_STATE[run.status] || run.status}${run.status === 'running' && run.tasks.length ? ` · ${finished} of ${run.tasks.length} done` : ''}`;
    head.append(el('span', 't-pill t-plan', run.tasks.length ? 'Plan' : 'Coordinator'), el('b', '', run.tasks.length > 1 ? `${run.tasks.length} tasks` : run.tasks[0]?.name || 'Reply'), el('span', 't-state', status));
    if (RUN_LIVE.has(run.status)) head.append(button('t-stop', 'Stop', () => app.net?.send({ t: 'team-stop', runId: run.id })));
    box.append(head);
    if (run.by) box.append(el('p', 't-by', run.by));
    if (run.reply) { const m = el('div', `m bot t-answer t-lead${run.asked ? ' t-asks' : ''}`); const body = el('div', 'body'); body.innerHTML = md(run.reply); m.append(body); box.append(m); }
    const list = el('div', 't-tasks');
    for (const t of run.tasks) {
      const key = `${run.id}:${t.id}`;
      const row = el('details', `t-trow t-${t.state}`);
      row.open = opened.has(key) ? !opened.has(`!${key}`) : ['running', 'waiting', 'failed', 'blocked'].includes(t.state) || run.tasks.length === 1;
      row.addEventListener('toggle', () => { opened.delete(key); opened.delete(`!${key}`); opened.add(key); if (!row.open) opened.add(`!${key}`); });
      const sum = el('summary');
      const dot = el('i', 'dot'); dot.style.setProperty('--c', app.panels[t.agent]?.row.style.getPropertyValue('--c') || '');
      const after = t.after.length ? ` · after ${t.after.map((id) => run.tasks.find((x) => x.id === id)?.title || id).join(', ')}` : '';
      sum.append(dot, el('span', 't-tt', t.title), el('span', 't-pill', t.name), el('span', 't-pill', t.modelLabel), el('span', `t-pill tier-${t.size}`, TIER[t.size] || ''),
        el('span', 't-ts', `${TASK_STATE[t.state] || t.state}${t.state === 'running' && t.steps ? ` · ${t.steps} step${t.steps === 1 ? '' : 's'}` : ''}`));
      row.append(sum);
      const body = el('div', 't-tbody');
      if (after && t.state === 'pending') body.append(el('p', 't-by', `Waiting${after}`));
      if (t.rerouted) body.append(el('p', 't-note', `Moved to ${t.name}: ${t.rerouted}`));
      if (t.state === 'running' && t.doing) body.append(el('p', 't-doing', `Working: ${t.doing}`));
      if (t.approval) {
        const ask = el('div', 't-approve');
        if (t.approval.question) ask.append(el('span', '', `${t.name} has a question with choices.`), button('', `Answer in ${t.name}'s chat`, () => { hide(); app.select(t.agent); }));
        else ask.append(el('span', '', `${t.name} wants to run: ${t.approval.summary || t.approval.name || 'an action'}`),
          button('ok', 'Allow', () => app.net?.send({ t: 'approve', agent: t.agent, requestId: t.approval.requestId, allow: true })),
          button('no', 'Deny', () => app.net?.send({ t: 'approve', agent: t.agent, requestId: t.approval.requestId, allow: false })));
        body.append(ask);
      }
      if (t.result) { const m = el('div', `m bot t-answer${t.state === 'running' ? ' streaming' : ''}`); const b = el('div', 'body'); b.innerHTML = md(t.result); m.append(b); body.append(m); }
      if (t.error && t.state !== 'done') body.append(el('p', 't-note', t.error));
      const acts = el('div', 't-changes');
      if (['failed', 'skipped', 'stopped', 'blocked'].includes(t.state)) acts.append(button('t-rev', 'Run again', () => app.net?.send({ t: 'team-retry', runId: run.id, taskId: t.id })));
      const rv = t.state === 'done' ? app.review?.get(t.agent) : null;
      if (rv?.files) acts.append(button('t-rev', `Review ${rv.files} changed file${rv.files === 1 ? '' : 's'}  +${rv.added} −${rv.removed}`, () => app.review.open(t.agent)));
      if (app.panels[t.agent]) acts.append(button('t-open', `Open ${t.name}'s chat`, () => { hide(); app.select(t.agent); }));
      body.append(acts);
      row.append(body);
      list.append(row);
    }
    if (run.tasks.length) box.append(list);
    if (run.summary) { const m = el('div', 'm bot t-answer t-report'); const b = el('div', 'body'); b.innerHTML = md(run.summary); m.append(b); box.append(m); }
    return box;
  }

  function card(e) {
    if (e.runId && runs.has(e.runId)) return runCard(e, runs.get(e.runId));
    const box = el('div', `t-card${e.error ? ' err' : ''}`);
    box.dataset.state = e.state || '';
    if (e.error) { box.textContent = e.error; return box; }
    if (e.state === 'assigning') { box.textContent = e.progress || 'Choosing who does this…'; return box; }
    if (e.state === STATE_HELD) { // held for the agent that has the context
      box.classList.add('asks');
      const head = el('div', 't-head'); head.append(el('b', '', e.name || e.agent), el('span', 't-pill', e.modelLabel || 'default model'), el('span', 't-state', 'Held until it finishes'));
      box.append(head, el('p', 't-why', e.reason || ''), el('p', 't-by', `${e.name} is busy and has the context for this, so Tandem will send it as soon as ${e.name} is done.`));
      box.append(button('t-open', 'Cancel', () => { app.net?.send({ t: 'team-unhold', entryId: e.id }); }));
      return box;
    }
    if (e.state === 'asked') { // the assistant needs one detail: the next message is the answer
      box.classList.add('asks');
      box.append(el('p', 't-why', e.asked || ''), el('p', 't-by', 'Type your answer below. It is routed together with your request.'));
      return box;
    }
    const head = el('div', 't-head');
    const dot = el('i', 'dot'); dot.style.setProperty('--c', app.panels[e.agent]?.row.style.getPropertyValue('--c') || '');
    const state = `${STATE[e.state] || ''}${e.state === 'working' && e.steps ? ` · ${e.steps} step${e.steps === 1 ? '' : 's'}` : ''}`;
    head.append(dot, el('b', '', e.name || e.agent), el('span', 't-pill', e.modelLabel || 'default model'), el('span', `t-pill tier-${e.tier}`, TIER[e.tier] || ''), el('span', 't-state', state));
    box.append(head, el('p', 't-why', e.reason || ''));
    if (e.by) box.append(el('p', 't-by', e.by));
    if (e.handoff?.length) box.append(el('p', 't-by', `Context handed over from ${e.handoff.map((h) => h.name).join(', ')}.`));
    if (e.note) box.append(el('p', 't-note', e.note));

    // The agent's answer, in this chat, as it arrives.
    if (e.result) {
      const answer = el('div', `m bot t-answer${e.state === 'working' ? ' streaming' : ''}`);
      const body = el('div', 'body'); body.innerHTML = md(e.result);
      answer.append(body);
      box.append(answer);
    } else if (e.state === 'working') {
      box.append(el('p', 't-doing', e.doing ? `Working: ${e.doing}` : 'Working…'));
    }
    if (e.state === 'working' && e.result && e.doing) box.append(el('p', 't-doing', `Working: ${e.doing}`));

    // An approval the agent is waiting for, answered here.
    if (e.approval) {
      const a = e.approval;
      const ask = el('div', 't-approve');
      if (a.question) {
        ask.append(el('span', '', `${e.name} has a question with choices.`), button('', `Answer in ${e.name}'s chat`, () => { hide(); app.select(e.agent); }));
      } else {
        ask.append(el('span', '', `${e.name} wants to run: ${a.summary || a.name || 'an action'}`),
          button('ok', 'Allow', () => { app.net?.send({ t: 'approve', agent: e.agent, requestId: a.requestId, allow: true }); }),
          button('no', 'Deny', () => { app.net?.send({ t: 'approve', agent: e.agent, requestId: a.requestId, allow: false }); }));
      }
      box.append(ask);
    }
    if (e.changes?.files) {
      // What this agent now has waiting for review. Each file opens its diff in the Review screen.
      const c = e.changes;
      const row = el('div', 't-changes');
      row.append(button('t-rev', `Review ${c.files} changed file${c.files === 1 ? '' : 's'}  +${c.added} −${c.removed}`, () => app.review.open(e.agent)));
      for (const f of c.list) {
        const b = button('t-file', f.path.split('/').pop(), () => app.review.open(e.agent, f.path)); b.title = `${f.path}  +${f.added} −${f.removed}`;
        row.append(b);
      }
      if (c.files > c.list.length) row.append(el('span', 't-more', `+ ${c.files - c.list.length} more`));
      box.append(row);
    }
    if (app.panels[e.agent]) box.append(button('t-open', `Open ${e.name}'s chat`, () => { hide(); app.select(e.agent); }));
    return box;
  }
  const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  const ended = (e) => (e.runId && runs.has(e.runId) ? !RUN_LIVE.has(runs.get(e.runId).status) : ENDED.has(e.state) || !!e.error);
  function chrome() {
    view.classList.toggle('empty', entries.length === 0);
    $('#team-clear').disabled = !entries.some(ended);
  }
  function build(e) {
    const task = el('div', 't-task'); task.append(el('div', 'bub', e.text));
    const c = card(e);
    rows.set(e.id, { task, card: c });
    feed.append(task, c);
  }
  function renderAll() {
    feed.querySelectorAll('.t-task, .t-card').forEach((n) => n.remove());
    rows.clear();
    for (const e of entries) build(e);
    chrome();
    feed.scrollTop = feed.scrollHeight;
  }
  /** Redraw one task's card, at most once per frame: an answer streams in many times a second. */
  function touch(e) {
    dirty.add(e);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const stick = nearBottom();
      for (const x of dirty) {
        const r = rows.get(x.id);
        if (!r) { renderAll(); break; }
        const next = card(x); r.card.replaceWith(next); r.card = next;
      }
      dirty.clear();
      chrome();
      if (stick) feed.scrollTop = feed.scrollHeight;
    });
  }
  const changed = (e) => { saveSoon(); if (e) touch(e); else renderAll(); };

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
    const answering = entries.length > 0 && entries[entries.length - 1].state === 'asked';
    const recent = entries.filter((e) => (e.agent || e.runId || e.state === 'asked') && !e.error).slice(-3).map((e) => {
      if (e.state === 'asked') return { text: e.text, asked: e.asked };
      const run = e.runId ? runs.get(e.runId) : null;
      const last = run ? [...run.tasks].reverse().find((t) => t.state === 'done') : null;
      return { text: e.text, agent: run ? last?.agent || run.tasks[0]?.agent : e.agent, result: ((run ? run.summary || last?.result : e.result) || '').slice(0, 400) };
    }).filter((r) => r.agent || r.asked);
    entries.push(entry);
    pending.set(request, entry);
    app.net.send({ t: 'team-send', request, entryId: entry.id, text, recent, answering, agent: $('#team-agent').value || undefined, tier: $('#team-tier').value || undefined });
    ta.value = ''; say(''); autosize();
    build(entry); chrome(); saveSoon();
    feed.scrollTop = feed.scrollHeight;
  }

  $('#btn-team').addEventListener('click', show);
  $('#team-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  ta.addEventListener('input', autosize);
  $('#team-clear').addEventListener('click', () => { entries = entries.filter((e) => !ended(e)); changed(); });
  $('#team-shared').addEventListener('click', () => { app.side('code'); app.code?.setSource('shared'); });
  app.review?.onChange((agent) => {
    for (const e of entries) if (e.runId && runs.get(e.runId)?.tasks.some((t) => t.agent === agent)) touch(e);
    const entry = counting.get(agent);
    if (!entry) return;
    counting.delete(agent);
    const r = app.review.get(agent);
    entry.changes = r && r.files ? { files: r.files, added: r.added, removed: r.removed, list: r.list.slice(0, 6).map((f) => ({ path: f.path, added: f.added || 0, removed: f.removed || 0 })) } : null;
    changed(entry);
  });

  /** What the agent has said so far for a task: all its messages, in order. */
  function answerOf(entry) {
    const l = live.get(entry.id);
    return l ? l.order.map((id) => l.texts[id]).filter((t) => t && t.trim()).join('\n\n') : '';
  }

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
      for (const e of entries) touch(e); // names and colours may have changed
    },
    /** The connection is up (or came back): read this repository's saved chat, then save what is here. */
    online() { if (loadedFor === app.repoPath && loadedFor) saveSoon(); else load(); },
    /** Another project was opened: it has its own chat. */
    repoChanged() { queueMicrotask(load); },
    receive(msg) {
      if (msg.t === 'team-chat') {
        if (msg.cwd !== app.repoPath || loadedFor === msg.cwd) return true;
        loadedFor = msg.cwd;
        // Work that was running when the app closed cannot be followed any more: its agent's own chat has the outcome.
        for (const r of msg.runs || []) runs.set(r.id, r);
        const held = new Set(msg.held || []); // messages the server is still holding for a busy agent
        const saved = (msg.entries || []).map((e) => (e.state === STATE_HELD && !held.has(e.id) ? { ...e, state: 'failed', error: 'This message was being held for a busy agent when Tandem closed, so it was not sent. Send it again.' }
          : ['working', 'waiting', 'assigning'].includes(e.state) ? { ...e, state: 'sent' } : e));
        const ids = new Set(saved.map((e) => e.id));
        entries = [...saved, ...entries.filter((e) => !ids.has(e.id))]; // anything typed while loading stays
        renderAll();
        if (entries.length !== saved.length) saveSoon();
        return true;
      }
      if (msg.t === 'shared') {
        app.showNotice(msg.error ? msg.error : `Shared ${msg.name} with every agent. It is in the Shared folder.`);
        if (!msg.error) app.code?.refreshTree();
        return true;
      }
      if (msg.t === 'team-run') {
        const run = msg.run; runs.set(run.id, run);
        for (const t of run.tasks) if (t.state === 'done' && !seenDone.has(`${run.id}:${t.id}`)) { seenDone.add(`${run.id}:${t.id}`); app.review?.refresh(t.agent); } // look up what the agent changed
        for (const e of entries) if (e.runId === run.id) touch(e);
        return true;
      }
      if (msg.t !== 'team') return false;
      if (msg.entryId) { // a held message: the server sends it when the agent finishes, or it failed to
        const held = entries.find((x) => x.id === msg.entryId);
        if (!held) return true;
        if (msg.error) { held.error = msg.error; held.state = 'failed'; }
        else if (msg.released) { Object.assign(held, msg.released, { state: 'working' }); watching.set(held.agent, held); live.set(held.id, { order: [], texts: {}, tools: new Set() }); }
        changed(held);
        return true;
      }
      const entry = pending.get(msg.request);
      if (!entry) return true;
      if (msg.run) { // the coordinator planned it, and it is already running on the server
        pending.delete(msg.request); delete entry.progress;
        entry.runId = msg.run.id; entry.state = 'sent'; runs.set(msg.run.id, msg.run);
        changed(entry);
        return true;
      }
      if (msg.progress) { entry.progress = msg.progress; touch(entry); return true; } // still deciding
      if (msg.asked) { pending.delete(msg.request); delete entry.progress; entry.asked = msg.asked; entry.state = 'asked'; changed(entry); return true; }
      pending.delete(msg.request);
      delete entry.progress;
      if (msg.error) { entry.error = msg.error; entry.state = 'failed'; }
      else if (msg.assignment.held) { Object.assign(entry, msg.assignment, { state: STATE_HELD }); } // waits for its agent: the server sends it later
      else { Object.assign(entry, msg.assignment, { state: 'working' }); watching.set(entry.agent, entry); live.set(entry.id, { order: [], texts: {}, tools: new Set() }); }
      changed(entry);
      return true;
    },
    /** Follow the agent that got a task: its words appear here as it writes them. */
    onEvent(agent, ev) {
      const entry = watching.get(agent);
      if (!entry) return;
      const l = live.get(entry.id);
      if (ev.k === 'msg' && l) {
        if (!(ev.id in l.texts)) { l.order.push(ev.id); l.texts[ev.id] = ''; }
        if (typeof ev.text === 'string') l.texts[ev.id] = ev.text;
        entry.result = answerOf(entry);
        touch(entry);
      } else if (ev.k === 'delta' && l && ev.id in l.texts) {
        l.texts[ev.id] += ev.text || '';
        entry.result = answerOf(entry);
        touch(entry);
      } else if (ev.k === 'tool') {
        const d = app.panels[agent]?.entries.get(ev.id)?.data || ev;
        if (l && !l.tools.has(ev.id)) { l.tools.add(ev.id); entry.steps = l.tools.size; }
        if (d.status === 'awaiting') {
          entry.state = 'waiting';
          entry.approval = d.name === 'AskUserQuestion' ? { id: ev.id, question: true } : { id: ev.id, requestId: d.requestId, name: d.name, summary: d.summary };
        } else {
          if (entry.approval?.id === ev.id) { delete entry.approval; entry.state = 'working'; }
          entry.doing = d.status === 'running' ? `${d.name || 'tool'} ${d.summary || ''}`.trim().slice(0, 90) : entry.doing;
        }
        touch(entry);
      } else if (ev.k === 'error') {
        entry.error = undefined;
        if (!entry.result) entry.result = String(ev.text || '').slice(0, 2000);
        touch(entry);
      } else if (ev.k === 'turn') {
        const text = answerOf(entry) || [...(app.panels[agent]?.entries.values() || [])].reverse().find((x) => x.text && !x.think)?.text || entry.result || '';
        entry.state = ev.ok === false ? 'failed' : 'done';
        entry.result = text.trim();
        delete entry.approval; delete entry.doing;
        watching.delete(agent); live.delete(entry.id);
        counting.set(agent, entry); // the server recounts this agent's changes when its turn ends
        app.review?.refresh(agent);
        changed(entry);
        saveNow();
      }
    },
  };
}
