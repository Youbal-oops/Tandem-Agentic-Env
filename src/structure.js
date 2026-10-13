// Settings → Structure: turn standardizing on, preview what it would split, and create the structured tree.
// The work happens on the server in plain code; this only asks and shows the answer.

const $ = (s) => document.querySelector(s);

export function createStructurePanel({ send, connected, notify, getAgents, setDraft }) {
  let status = { enabled: false, eligible: false, origin: 'opened', settings: { minLines: 150, minGroups: 3 } };
  let lastPrompt = '';
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };

  function showStatus(s) {
    if (!s) return;
    status = s;
    $('#set-structure-on').checked = s.enabled;
    $('#set-structure-lines').value = s.settings.minLines;
    $('#set-structure-groups').value = s.settings.minGroups;
    const why = s.eligible
      ? `This project came in through Tandem (${s.origin}), so it can be standardized.`
      : 'This project was opened from a folder on this computer, so Tandem will not restructure it. Clone or fork it through Tandem, or mark it as a fork below.';
    $('#structure-status').textContent = `${s.enabled ? 'On.' : 'Off.'} ${why}`;
    $('#structure-plan').disabled = !s.enabled || !s.eligible;
    $('#structure-create').disabled = !s.enabled || !s.eligible;
    $('#structure-fork').hidden = s.eligible;
  }

  function showPlan(plan) {
    const box = $('#structure-result');
    const t = plan.totals;
    box.replaceChildren(el('p', `${t.split} file${t.split === 1 ? '' : 's'} would be split into ${t.parts} pieces (${t.linesBefore} lines; the largest file afterwards is ${t.largestAfter} lines). ${t.reported} reported only, ${t.skipped} left alone.`, 'structure-total'));
    const splits = plan.entries.filter((e) => e.status === 'split');
    for (const e of splits) {
      const d = document.createElement('details'); d.className = 'structure-entry';
      d.append(el('summary', `${e.file} · ${e.lines} → ${e.rootLines} lines · ${e.parts.length} pieces`));
      for (const p of e.parts) d.append(el('div', `${p.file.split('/').pop()} (${p.lines} lines): ${p.names.join(', ')}${p.names.length >= 6 ? '…' : ''}`));
      box.append(d);
    }
    const reported = plan.entries.filter((e) => e.status === 'report');
    if (reported.length) {
      const d = document.createElement('details'); d.className = 'structure-entry';
      d.append(el('summary', `${reported.length} large C, C++ or EJS file${reported.length === 1 ? '' : 's'} (reported, not changed)`));
      for (const e of reported) d.append(el('div', `${e.file} · ${e.lines} lines${e.approxFunctions ? ` · about ${e.approxFunctions} functions` : ''}`));
      box.append(d);
    }
    const skipped = plan.entries.filter((e) => e.status === 'skipped');
    if (skipped.length) {
      const d = document.createElement('details'); d.className = 'structure-entry';
      d.append(el('summary', `${skipped.length} left alone`));
      for (const e of skipped.slice(0, 60)) d.append(el('div', `${e.file}: ${e.reason}`));
      box.append(d);
    }
    if (plan.truncated) box.append(el('p', 'Only the first 300 files are listed.'));
  }

  function showCreated(msg) {
    showPlan(msg.plan);
    const box = $('#structure-result');
    if (!msg.created) { box.prepend(el('p', msg.reason, 'structure-total')); return; }
    lastPrompt = msg.prompt || '';
    const done = el('div', undefined, 'structure-done');
    done.append(el('p', `Created branch ${msg.branch} (commit ${msg.commit}). Your original files were not touched.`),
      el('p', msg.path, 'structure-path'));
    const row = el('div', undefined, 'form-row');
    const select = document.createElement('select');
    for (const a of getAgents()) { const o = el('option', a.name); o.value = a.id; select.append(o); }
    const ask = el('button', 'Ask an agent to review the names');
    ask.type = 'button';
    ask.addEventListener('click', () => { if (lastPrompt && setDraft(select.value, lastPrompt)) { $('#settings-dialog').close(); notify('The summary is in the chat draft. Nothing was sent.'); } });
    row.append(select, ask);
    done.append(row, el('p', 'The summary lists file and function names only, no code, so reviewing it costs very little. It is added to a draft; you decide whether to send it.'));
    box.prepend(done);
  }

  $('#btn-settings').addEventListener('click', () => { if (connected()) send({ t: 'structure-status' }); });
  document.querySelectorAll('#settings-dialog [data-section="structure"]').forEach((b) => b.addEventListener('click', () => { if (connected()) send({ t: 'structure-status' }); }));
  $('#save-structure').addEventListener('click', () => {
    if (!connected()) return notify('Connect to the local server first.');
    send({ t: 'savesettings', settings: { structure: { enabled: $('#set-structure-on').checked, minLines: Number($('#set-structure-lines').value), minGroups: Number($('#set-structure-groups').value) } } });
    setTimeout(() => send({ t: 'structure-status' }), 200);
  });
  $('#structure-plan').addEventListener('click', () => { $('#structure-result').textContent = 'Reading the project…'; send({ t: 'structure-plan' }); });
  $('#structure-create').addEventListener('click', () => {
    if (!confirm('Create the structured tree? Tandem will make a new git worktree and branch from the last commit and write the split files there. Your current files are not changed.')) return;
    $('#structure-result').textContent = 'Building the tree…'; send({ t: 'structure-create' });
  });
  $('#structure-fork').addEventListener('click', () => {
    if (confirm('Mark this project as a fork? Only do this if its files are not the ones you push straight to main: Tandem will then be allowed to build a restructured copy on its own branch (it still never changes your files in place).')) send({ t: 'structure-fork' });
  });

  return {
    receive(msg) {
      if (msg.t !== 'structure') return false;
      if (msg.kind === 'status') showStatus(msg.status);
      else if (msg.kind === 'plan') { showStatus(msg.status); showPlan(msg.plan); }
      else if (msg.kind === 'created') { showStatus(msg.status); showCreated(msg); }
      else if (msg.kind === 'error') $('#structure-result').textContent = msg.error;
      return true;
    },
  };
}
