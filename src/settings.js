// The Settings dialog and the Review button. Review limits are stored by the server; the other sections only
// open the dialogs and switches that already exist, so there is one place to change each thing.

const $ = (s) => document.querySelector(s);

export function createSettingsDialog({ send, connected, notify, getAgent }) {
  let saved = { enabled: true, maxLines: 300, maxFiles: 10, hardStop: true, margin: 25 };
  let reviewWindow = null;
  const held = new Set();

  const dirty = () => $('#set-review-on').checked !== saved.enabled || Number($('#set-max-lines').value) !== saved.maxLines || Number($('#set-max-files').value) !== saved.maxFiles
    || $('#set-hard-stop').checked !== saved.hardStop || Number($('#set-margin').value) !== saved.margin;
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

  function show(review, force) {
    if (!review) return;
    saved = { enabled: review.enabled, maxLines: review.maxLines, maxFiles: review.maxFiles, hardStop: review.hardStop, margin: review.margin };
    if (force || !dirty()) {
      $('#set-review-on').checked = saved.enabled; $('#set-max-lines').value = saved.maxLines; $('#set-max-files').value = saved.maxFiles;
      $('#set-hard-stop').checked = saved.hardStop; $('#set-margin').value = saved.margin;
    }
    sync();
  }

  function labels() {
    $('#set-theme').textContent = $('#btn-theme').textContent;
    $('#set-eco').textContent = `Eco mode: ${$('#btn-eco').classList.contains('on') ? 'on' : 'off'}`;
    $('#set-lite').textContent = `Lite mode: ${$('#btn-lite').classList.contains('on') ? 'on' : 'off'}`;
    const learn = $('#btn-learning').getAttribute('aria-pressed') === 'true';
    $('#set-learning-mode').checked = learn;
  }

  function section(name) {
    document.querySelectorAll('#settings-dialog [data-section]').forEach((b) => b.classList.toggle('on', b.dataset.section === name));
    document.querySelectorAll('#settings-dialog [data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  }

  function openReview() {
    const id = getAgent();
    const url = `/review.html?agent=${encodeURIComponent(id || '')}`;
    if (reviewWindow && !reviewWindow.closed) { reviewWindow.focus(); return; }
    reviewWindow = window.open(url, 'tandem-review', 'popup=yes,width=1180,height=820');
    if (!reviewWindow) notify('The browser blocked the pop-out window. Allow pop-ups for Tandem, then try again.');
  }

  function badge() {
    const btn = $('#btn-review');
    btn.classList.toggle('attention', held.size > 0);
    btn.textContent = held.size ? `Review (${held.size} held)` : 'Review';
  }

  $('#btn-settings').addEventListener('click', () => { if (!connected()) return notify('Connect to the local server first.'); labels(); section('review'); $('#settings-dialog').showModal(); send({ t: 'localstate' }); });
  $('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
  document.querySelectorAll('#settings-dialog [data-section]').forEach((b) => b.addEventListener('click', () => { labels(); section(b.dataset.section); }));
  document.querySelectorAll('#settings-dialog [data-open]').forEach((b) => b.addEventListener('click', () => {
    $('#settings-dialog').close();
    $(b.dataset.open).click();
  }));
  for (const id of ['#set-review-on', '#set-max-lines', '#set-max-files', '#set-hard-stop', '#set-margin']) $(id).addEventListener('input', sync);
  $('#save-settings').addEventListener('click', () => {
    if (!connected()) return notify('Connect to the local server first.');
    const maxLines = Number($('#set-max-lines').value); const maxFiles = Number($('#set-max-files').value);
    if (!Number.isInteger(maxLines) || maxLines < 20 || maxLines > 5000) return status('Lines must be a whole number from 20 to 5000.');
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 200) return status('Files must be a whole number from 1 to 200.');
    const margin = Number($('#set-margin').value);
    if (!Number.isInteger(margin) || margin < 5 || margin > 100) return status('The margin must be a whole number from 5 to 100.');
    send({ t: 'savesettings', settings: { review: { enabled: $('#set-review-on').checked, maxLines, maxFiles, hardStop: $('#set-hard-stop').checked, margin } } });
    status('Saving…');
  });
  $('#set-learning-mode').addEventListener('change', () => $('#btn-learning').click());
  $('#btn-review').addEventListener('click', openReview);
  $('#open-review').addEventListener('click', openReview);

  return {
    /** Server messages: settings arrive on their own, inside local state, and as review updates. */
    receive(msg) {
      if (msg.t === 'settings') { show(msg.settings?.review, true); status('Saved'); return true; }
      if (msg.t === 'review') {
        const r = msg.review;
        if (r.held && !held.has(r.agent)) notify(`${r.agent} needs your review: ${r.reason}.`);
        if (r.held) held.add(r.agent); else held.delete(r.agent);
        badge();
        return true;
      }
      return false;
    },
    local(settings) { show(settings?.review, false); },
  };
}
