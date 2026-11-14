// The Settings dialog and the Review button. Review limits are stored by the server; the other sections only
// open the dialogs and switches that already exist, so there is one place to change each thing.

const $ = (s) => document.querySelector(s);

export function createSettingsDialog({ send, connected, notify, openReview = () => {}, getAgents = () => [], defaultGuide = () => '', defaultCoordinatorGuide = () => '' }) {
  let saved = { enabled: true, maxLines: 300, maxFiles: 10, hardStop: true, margin: 25 };
  let savedAgents = { pingMain: true, allowFull: false, tools: true };
  let touched = false; // true once the user has changed a control; until then the server's values fill the form
  const held = new Set();

  const dirty = () => $('#set-review-on').checked !== saved.enabled || Number($('#set-max-lines').value) !== saved.maxLines || Number($('#set-max-files').value) !== saved.maxFiles
    || $('#set-hard-stop').checked !== saved.hardStop || Number($('#set-margin').value) !== saved.margin
    || $('#set-ping-main').checked !== savedAgents.pingMain || $('#set-allow-full').checked !== savedAgents.allowFull || $('#set-tools').checked !== savedAgents.tools;
  const status = (text) => { $('#settings-status').textContent = text; };
  const refreshStatus = () => status(dirty() ? 'Unsaved changes' : '');

  /** Enable what applies, and show the cutoff the budget and margin work out to (the same sum the server uses). */
  function sync() {
    const on = $('#set-review-on').checked; const hard = on && $('#set-hard-stop').checked;
    for (const id of ['#set-max-lines', '#set-max-files', '#set-hard-stop']) $(id).disabled = !on;
    $('#set-margin').disabled = !hard;
    const lines = Number($('#set-max-lines').value); const files = Number($('#set-max-files').value); const pct = Number($('#set-margin').value);
    $('#set-cutoff').textContent = hard && lines && files && pct ? `Cutoff: ${Math.ceil(lines * (1 + pct / 100))} lines or ${files + Math.max(1, Math.ceil(files * pct / 100))} files` : on ? 'No mid-job cutoff' : 'No limits';
    refreshStatus();
  }

  function showAgents(agents, force) {
    if (!agents) return;
    savedAgents = { pingMain: agents.pingMain !== false, allowFull: agents.allowFull === true, tools: agents.tools !== false };
    if (force || !touched) { $('#set-ping-main').checked = savedAgents.pingMain; $('#set-allow-full').checked = savedAgents.allowFull; $('#set-tools').checked = savedAgents.tools; }
    refreshStatus();
  }

  function show(review, force) {
    if (!review) return;
    saved = { enabled: review.enabled, maxLines: review.maxLines, maxFiles: review.maxFiles, hardStop: review.hardStop, margin: review.margin };
    if (force || !touched) {
      $('#set-review-on').checked = saved.enabled; $('#set-max-lines').value = saved.maxLines; $('#set-max-files').value = saved.maxFiles;
      $('#set-hard-stop').checked = saved.hardStop; $('#set-margin').value = saved.margin;
    }
    sync();
  }

  // ---- Team: who assigns tasks, and the dispatcher's guide. An empty saved guide means the built-in one.
  let savedTeam = { dispatcher: 'auto', guide: '', mode: 'dispatcher', coordinator: 'auto', coordinatorGuide: '' };
  let teamTouched = false;
  function teamOptions() {
    const select = $('#set-team-dispatcher'); const value = teamTouched ? select.value : savedTeam.dispatcher;
    select.querySelectorAll('option[data-agent]').forEach((o) => o.remove());
    for (const a of getAgents()) { const o = Object.assign(document.createElement('option'), { value: a.id, textContent: `Always ${a.name}, on its cheapest model` }); o.dataset.agent = a.id; select.append(o); }
    select.value = [...select.options].some((o) => o.value === value) ? value : 'auto';
    const coord = $('#set-team-coordinator'); const chosen = teamTouched ? coord.value : savedTeam.coordinator;
    coord.querySelectorAll('option[data-agent]').forEach((o) => o.remove());
    for (const a of getAgents()) { const o = Object.assign(document.createElement('option'), { value: a.id, textContent: `Always ${a.name}` }); o.dataset.agent = a.id; coord.append(o); }
    coord.value = [...coord.options].some((o) => o.value === chosen) ? chosen : 'auto';
  }
  function showTeam(team, force) {
    if (!team) return;
    savedTeam = { dispatcher: team.dispatcher || 'auto', guide: team.guide || '', mode: team.mode || 'dispatcher', coordinator: team.coordinator || 'auto', coordinatorGuide: team.coordinatorGuide || '' };
    if (force || !teamTouched) { teamTouched = false; teamOptions(); $('#set-team-mode').value = savedTeam.mode; $('#set-team-guide').value = savedTeam.guide || defaultGuide(); $('#set-team-coordinator-guide').value = savedTeam.coordinatorGuide || defaultCoordinatorGuide(); $('#team-settings-status').textContent = savedTeam.guide ? 'Using your guide' : 'Using the built-in guide'; }
  }
  for (const id of ['#set-team-mode', '#set-team-coordinator', '#set-team-coordinator-guide', '#set-team-dispatcher', '#set-team-guide']) $(id).addEventListener('input', () => { teamTouched = true; $('#team-settings-status').textContent = 'Unsaved changes'; });
  $('#save-team').addEventListener('click', () => {
    if (!connected()) return notify('Connect to the local server first.');
    const text = $('#set-team-guide').value.trim();
    const coordText = $('#set-team-coordinator-guide').value.trim();
    send({ t: 'savesettings', settings: { team: { dispatcher: $('#set-team-dispatcher').value, guide: text === defaultGuide().trim() ? '' : text, mode: $('#set-team-mode').value, coordinator: $('#set-team-coordinator').value, coordinatorGuide: coordText === defaultCoordinatorGuide().trim() ? '' : coordText } } });
    $('#team-settings-status').textContent = 'Saving…';
  });
  $('#reset-team').addEventListener('click', () => { $('#set-team-guide').value = defaultGuide(); $('#set-team-coordinator-guide').value = defaultCoordinatorGuide(); teamTouched = true; $('#team-settings-status').textContent = 'Built-in guide restored. Press Save to keep it.'; });

  function labels() {
    teamOptions();
    $('#set-eco').checked = $('#btn-eco').classList.contains('on');
    $('#set-planets').checked = $('#btn-planets').getAttribute('aria-pressed') === 'true';
    const learn = $('#btn-learning').getAttribute('aria-pressed') === 'true';
    $('#set-learning-mode').checked = learn;
    $('#set-todo-mode').checked = $('#profile-todo-mode').checked;
    try { $('#set-child-window').checked = localStorage.getItem('tandem:child-window') !== 'false'; } catch { $('#set-child-window').checked = true; }
  }

  function section(name) {
    document.querySelectorAll('#settings-dialog [data-section]').forEach((b) => b.classList.toggle('on', b.dataset.section === name));
    document.querySelectorAll('#settings-dialog [data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  }

  function badge() {
    const btn = $('#btn-review');
    btn.classList.toggle('attention', held.size > 0);
    btn.textContent = held.size ? `Review (${held.size} waiting)` : 'Review';
  }

  $('#btn-settings').addEventListener('click', () => { if (!connected()) return notify('Connect to the local server first.'); labels(); section('review'); $('#settings-dialog').showModal(); send({ t: 'localstate' }); });
  $('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
  document.querySelectorAll('#settings-dialog [data-section]').forEach((b) => b.addEventListener('click', () => { labels(); section(b.dataset.section); }));
  document.querySelectorAll('#settings-dialog [data-open]').forEach((b) => b.addEventListener('click', () => {
    $('#settings-dialog').close();
    $(b.dataset.open).click();
  }));
  const touch = () => { touched = true; sync(); };
  for (const id of ['#set-review-on', '#set-max-lines', '#set-max-files', '#set-hard-stop', '#set-margin']) $(id).addEventListener('input', touch);
  $('#save-settings').addEventListener('click', () => {
    if (!connected()) return notify('Connect to the local server first.');
    const maxLines = Number($('#set-max-lines').value); const maxFiles = Number($('#set-max-files').value);
    if (!Number.isInteger(maxLines) || maxLines < 20 || maxLines > 5000) return status('Lines must be a whole number from 20 to 5000.');
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 200) return status('Files must be a whole number from 1 to 200.');
    const margin = Number($('#set-margin').value);
    if (!Number.isInteger(margin) || margin < 5 || margin > 100) return status('The margin must be a whole number from 5 to 100.');
    send({ t: 'savesettings', settings: { review: { enabled: $('#set-review-on').checked, maxLines, maxFiles, hardStop: $('#set-hard-stop').checked, margin }, agents: { pingMain: $('#set-ping-main').checked, allowFull: $('#set-allow-full').checked, tools: $('#set-tools').checked } } });
    status('Saving…');
  });
  $('#set-learning-mode').addEventListener('change', () => $('#btn-learning').click());
  $('#set-eco').addEventListener('change', () => $('#btn-eco').click());
  $('#set-planets').addEventListener('change', () => { $('#settings-dialog').close(); $('#btn-planets').click(); });
  $('#set-todo-mode').addEventListener('change', () => $('#profile-todo-mode').click());
  $('#set-child-window').addEventListener('change', (e) => { try { localStorage.setItem('tandem:child-window', String(e.target.checked)); } catch { /* the choice just will not persist */ } });
  $('#set-ping-main').addEventListener('input', touch);
  $('#set-allow-full').addEventListener('change', (e) => {
    touched = true;
    if (e.target.checked && !confirm('Allow full access mode? An agent in this mode runs without a sandbox: it can use the internet and change anything on this computer your account can reach. You still choose it per agent, and Tandem asks again each time.')) e.target.checked = false;
    sync();
  });
  $('#open-review').addEventListener('click', () => { $('#settings-dialog').close(); openReview(); });

  return {
    /** Server messages: settings arrive on their own, inside local state, and as review updates. */
    receive(msg) {
      if (msg.t === 'settings') { touched = false; show(msg.settings?.review, true); showAgents(msg.settings?.agents, true); showTeam(msg.settings?.team, true); status('Saved'); return true; }
      if (msg.t === 'review') {
        const r = msg.review;
        if (r.held && !held.has(r.agent)) notify(`${r.agent} needs your review: ${r.reason}.`);
        if (r.held) held.add(r.agent); else held.delete(r.agent);
        badge();
        return true;
      }
      return false;
    },
    local(settings) { show(settings?.review, false); showAgents(settings?.agents, false); showTeam(settings?.team, false); },
  };
}
