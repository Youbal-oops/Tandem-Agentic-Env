// Notes, the global prompt and the learning profile: things that belong to this computer. (Files are in code.js.)
export function createLocalTools({ send, connected, getRepo, getAgents, setDraft, notify, onLearning = () => {}, onTodoMode = () => {}, onCheckpoints = () => {}, onSettings = () => {} }) {
  const $ = (s) => document.querySelector(s);
  let notesCwd = '';
  let notesSaved = '';
  let notesPending = null;
  const ask = (msg) => { if (!connected()) { notify('Connect to the local server first.'); return false; } send(msg); return true; };
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
    $('#profile-observed').textContent = profile.known?.length ? `Picked up from your work (most often first): ${profile.known.map((k) => `${k.name} ×${k.n}`).join(', ')}` : 'Nothing picked up yet. A technology shows here once it has come up in your messages or edits a few times.';
    $('#profile-status').textContent = 'Saved locally';
  }
  function showLearning(msg) {
    if (typeof msg.learningMode === 'boolean') { $('#profile-learning-mode').checked = msg.learningMode; onLearning(msg.learningMode); }
    if (typeof msg.todoMode === 'boolean') { $('#profile-todo-mode').checked = msg.todoMode; onTodoMode(msg.todoMode); }
    if (msg.checkpoints) onCheckpoints(msg.checkpoints);
    if (Array.isArray(msg.stack)) $('#profile-stack').textContent = msg.stack.length ? `Detected in this repository: ${msg.stack.join(', ')}` : 'No technologies detected in this repository yet.';
  }
  const setLearningMode = (on) => { if (!ask({ t: 'learningmode', on })) { $('#profile-learning-mode').checked = !on; } };
  $('#profile-learning-mode').addEventListener('change', (e) => setLearningMode(e.target.checked));
  $('#profile-todo-mode').addEventListener('change', (e) => { if (!ask({ t: 'todomode', on: e.target.checked })) e.target.checked = !e.target.checked; });
  $('#btn-learning').addEventListener('click', () => setLearningMode($('#btn-learning').getAttribute('aria-pressed') !== 'true'));
  $('#btn-profile').addEventListener('click', () => { if (!connected()) return notify('Connect to the local server first.'); $('#profile-dialog').showModal(); ask({ t: 'localstate' }); });
  $('#close-profile').addEventListener('click', () => $('#profile-dialog').close());
  $('#save-profile').addEventListener('click', () => {
    const profile = { familiar: $('#profile-familiar').value, learning: $('#profile-learning').value, level: $('#profile-level').value, style: $('#profile-style').value, checkpoints: $('#profile-checkpoints').value };
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
    repoChanged() {},
    receive(msg) {
      if (msg.t === 'prompt') { showPrompt(msg.prompt, true); return true; }
      if (msg.t === 'learnerprofile') { showProfile(msg.learnerProfile); showLearning(msg); return true; }
      if (msg.t === 'localstate') {
        if (msg.settings) onSettings(msg.settings);
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
      return false;
    },
  };
}
