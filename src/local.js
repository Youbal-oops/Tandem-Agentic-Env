// Local tools are read-only until the user saves notes or sends a prepared draft.
export function createLocalTools({ send, connected, getRepo, getAgents, setDraft, notify, onLearning = () => {} }) {
  const $ = (s) => document.querySelector(s);
  let request = 0;
  let folder = '';
  let tab = 'files';
  let preview = null;
  let notesCwd = '';
  let notesSaved = '';
  let notesPending = null;
  const ask = (msg) => { if (!connected()) { notify('Connect to the local server first.'); return false; } send(msg); return true; };
  function inspect(kind, extra = {}) {
    if (!ask({ t: kind, request: ++request, ...extra })) return;
    preview = null; $('#attach-context').disabled = true;
    $('#inspect-status').textContent = 'Loading…';
    $('#inspect-content').textContent = '';
  }
  function load() {
    $('#file-list').hidden = tab !== 'files';
    $('#diff-mode').hidden = tab !== 'diff';
    $('#inspect-files').classList.toggle('on', tab === 'files');
    $('#inspect-diff').classList.toggle('on', tab === 'diff');
    inspect(tab === 'files' ? 'files' : 'diff', tab === 'files' ? { path: folder } : { mode: $('#diff-mode').value });
  }
  function chooseAgents() {
    const select = $('#context-agent'); const selected = select.value; select.replaceChildren();
    for (const a of getAgents()) { const option = document.createElement('option'); option.value = a.id; option.textContent = a.name; select.append(option); }
    if ([...select.options].some((o) => o.value === selected)) select.value = selected;
  }
  $('#btn-inspect').addEventListener('click', () => { if (!connected()) return notify('Connect to the local server first.'); chooseAgents(); $('#inspect-dialog').showModal(); load(); });
  $('#close-inspect').addEventListener('click', () => $('#inspect-dialog').close());
  $('#inspect-files').addEventListener('click', () => { tab = 'files'; load(); });
  $('#inspect-diff').addEventListener('click', () => { tab = 'diff'; load(); });
  $('#diff-mode').addEventListener('change', load);
  $('#inspect-refresh').addEventListener('click', load);
  $('#attach-context').addEventListener('click', () => {
    if (!preview || preview.cwd !== getRepo()) return notify('Refresh the preview for the current repository.');
    const text = `${preview.kind === 'file' ? 'File' : 'Git diff'}: ${preview.path || preview.mode}\n\n${preview.text}`;
    if (text.length > 30000) return notify('This preview is too large for a chat draft. Copy a smaller excerpt.');
    if (setDraft($('#context-agent').value, text)) $('#inspect-dialog').close();
  });
  $('#btn-stop-all').addEventListener('click', () => ask({ t: 'stopall' }));
  $('#btn-notes').addEventListener('click', () => { if (!connected()) return notify('Connect to the local server first.'); $('#notes-dialog').showModal(); ask({ t: 'localstate' }); });
  $('#close-notes').addEventListener('click', () => $('#notes-dialog').close());
  $('#repo-notes').addEventListener('input', () => {
    sessionStorage.setItem(`tandem:notes:${notesCwd}`, $('#repo-notes').value);
    $('#notes-status').textContent = $('#repo-notes').value === notesSaved ? 'Saved locally' : 'Unsaved draft';
  });
  function saveNotes() {
    if (!notesCwd) return;
    notesPending = { cwd: notesCwd, text: $('#repo-notes').value };
    if (ask({ t: 'savenotes', ...notesPending })) $('#notes-status').textContent = 'Saving…';
  }
  $('#save-notes').addEventListener('click', saveNotes);
  let promptSaved = { text: '', on: true };
  const promptDirty = () => $('#global-prompt').value !== promptSaved.text || $('#prompt-on').checked !== promptSaved.on;
  const promptStatus = () => { $('#prompt-status').textContent = promptDirty() ? 'Unsaved changes' : promptSaved.text.trim() ? (promptSaved.on ? 'Active for all agents' : 'Saved, switched off') : 'No prompt set'; };
  $('#btn-prompt').addEventListener('click', () => { if (!connected()) return notify('Connect to the local server first.'); $('#prompt-dialog').showModal(); ask({ t: 'localstate' }); });
  $('#close-prompt').addEventListener('click', () => $('#prompt-dialog').close());
  $('#global-prompt').addEventListener('input', promptStatus);
  $('#prompt-on').addEventListener('change', promptStatus);
  $('#save-prompt').addEventListener('click', () => { if (ask({ t: 'saveprompt', text: $('#global-prompt').value, on: $('#prompt-on').checked })) $('#prompt-status').textContent = 'Saving…'; });
  $('#global-prompt').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('#save-prompt').click(); } });
  let learnerProfile = null;
  function showProfile(profile) {
    if (!profile) return;
    learnerProfile = profile;
    $('#profile-familiar').value = profile.familiar || ''; $('#profile-learning').value = profile.learning || '';
    $('#profile-level').value = profile.level || 'familiar'; $('#profile-style').value = profile.style || 'plain'; $('#profile-checkpoints').value = profile.checkpoints || 'normal';
    $('#profile-observed').textContent = profile.observed?.length ? `Observed in your work: ${profile.observed.join(', ')}` : 'No technologies observed yet.';
    $('#profile-status').textContent = 'Saved locally';
  }
  function showLearning(msg) {
    if (typeof msg.learningMode === 'boolean') { $('#profile-learning-mode').checked = msg.learningMode; onLearning(msg.learningMode); }
    if (Array.isArray(msg.stack)) $('#profile-stack').textContent = msg.stack.length ? `Detected in this repository: ${msg.stack.join(', ')}` : 'No technologies detected in this repository yet.';
  }
  const setLearningMode = (on) => { if (!ask({ t: 'learningmode', on })) { $('#profile-learning-mode').checked = !on; } };
  $('#profile-learning-mode').addEventListener('change', (e) => setLearningMode(e.target.checked));
  $('#btn-learning').addEventListener('click', () => setLearningMode($('#btn-learning').getAttribute('aria-pressed') !== 'true'));
  $('#btn-profile').addEventListener('click', () => { if (!connected()) return notify('Connect to the local server first.'); $('#profile-dialog').showModal(); ask({ t: 'localstate' }); });
  $('#close-profile').addEventListener('click', () => $('#profile-dialog').close());
  $('#save-profile').addEventListener('click', () => {
    const profile = { familiar: $('#profile-familiar').value, learning: $('#profile-learning').value, level: $('#profile-level').value, style: $('#profile-style').value, checkpoints: $('#profile-checkpoints').value, observed: learnerProfile?.observed || [] };
    if (ask({ t: 'savelearnerprofile', profile })) $('#profile-status').textContent = 'Saving…';
  });
  function showPrompt(p, force) {
    if (!p) return;
    if (force || !promptDirty()) { $('#global-prompt').value = p.text; $('#prompt-on').checked = p.on; }
    promptSaved = { text: p.text, on: p.on }; promptStatus();
  }
  $('#repo-notes').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNotes(); } });
  return {
    openWorkspace() { ask({ t: 'localstate' }); },
    repoChanged() { folder = ''; preview = null; request++; $('#inspect-dialog').close(); },
    receive(msg) {
      if (msg.t === 'prompt') { showPrompt(msg.prompt, true); return true; }
      if (msg.t === 'learnerprofile') { showProfile(msg.learnerProfile); showLearning(msg); return true; }
      if (msg.t === 'localstate') {
        showPrompt(msg.prompt, false);
        showProfile(msg.learnerProfile);
        showLearning(msg);
        const list = $('#recent-repos'); list.replaceChildren();
        for (const cwd of msg.recent || []) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'recent-repo';
          button.textContent = cwd; button.title = cwd; button.disabled = cwd === getRepo();
          button.addEventListener('click', () => ask({ t: 'repo', cwd })); list.append(button);
        }
        if (msg.cwd !== getRepo()) return;
        const existingDraft = sessionStorage.getItem(`tandem:notes:${msg.cwd}`);
        notesCwd = msg.cwd; notesSaved = msg.notes || '';
        const editedWhileSaving = msg.saved && notesPending?.cwd === msg.cwd && $('#repo-notes').value !== notesPending.text;
        if (!editedWhileSaving) $('#repo-notes').value = msg.saved ? notesSaved : existingDraft ?? notesSaved;
        if (msg.saved && !editedWhileSaving) sessionStorage.removeItem(`tandem:notes:${msg.cwd}`);
        if (msg.saved) notesPending = null;
        $('#notes-repo').textContent = msg.cwd;
        $('#notes-status').textContent = $('#repo-notes').value === notesSaved ? 'Saved locally' : 'Unsaved draft';
        return true;
      }
      if (msg.t !== 'inspect') return false;
      if (msg.request !== request || msg.cwd !== getRepo()) return true;
      $('#inspect-status').textContent = msg.error || '';
      if (msg.error) return true;
      if (msg.kind === 'files') {
        folder = msg.path || ''; $('#inspect-location').textContent = `${getRepo()}${folder ? ' / ' + folder : ''}`;
        const list = $('#file-list'); list.replaceChildren();
        function row(label, file, directory) {
          const b = document.createElement('button'); b.textContent = label;
          b.addEventListener('click', () => { if (directory) { folder = file; load(); } else inspect('file', { path: file }); }); list.append(b);
        }
        if (folder) row('↑ Parent folder', folder.split('/').slice(0, -1).join('/'), true);
        for (const e of msg.entries) row(`${e.directory ? '▸ ' : ''}${e.name}`, e.path, e.directory);
        $('#inspect-status').textContent = msg.truncated ? 'Showing the first 300 entries.' : 'Choose a text file to preview.';
      } else {
        preview = msg; $('#inspect-location').textContent = msg.path || `Git diff · ${msg.mode}`;
        $('#inspect-content').textContent = msg.text; $('#attach-context').disabled = false;
        $('#inspect-status').textContent = msg.kind === 'file' ? `${msg.bytes.toLocaleString()} bytes · read-only` : 'Read-only diff';
      }
      return true;
    },
  };
}
