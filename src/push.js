// The Push dialog: review what changed, pick files to commit, edit the message and branch, then push.
// Pushes only ever go to tandem/... branches (the server enforces it); this just makes the choices visible.

const PRIVATE = /(^|[\\/])(\.env(\..*)?|id_rsa.*|.*\.(pem|key|p12|pfx)|credentials(\.json)?|secrets?(\..*)?)$/i;
const LOCAL = /^\.tandem\//;

export function createPushDialog({ send, connected, getSource, notify }) {
  const $ = (s) => document.querySelector(s);
  const dialog = $('#push-dialog');
  let info = null;
  let pending = false;

  const boxes = () => [...document.querySelectorAll('#push-files input[type=checkbox]')];
  const picked = () => ($('#push-all').checked ? boxes().filter((b) => b.checked).map((b) => b.value) : []);
  const suffix = () => $('#push-branch').value.trim().replace(/^\/+|\/+$/g, '');
  const status = (text, bad = false) => { const el = $('#push-status'); el.textContent = text; el.classList.toggle('bad', bad); };

  function summarize() {
    const files = picked();
    const branch = `${info?.prefix || 'tandem/'}${suffix()}`;
    const bad = !info || !suffix() || /[^A-Za-z0-9._\/-]/.test(suffix()) || /\.\.|\/\/|\.lock$/.test(suffix());
    const needsMessage = files.length > 0 && !$('#push-message').value.trim();
    const left = (info?.files.length || 0) - files.length;
    $('#push-count').textContent = info?.files.length ? `${files.length} of ${info.files.length} selected` : '';
    $('#push-summary').textContent = !info ? ''
      : files.length ? `Commits ${files.length} file${files.length === 1 ? '' : 's'}, then pushes to origin/${branch}.${left ? ` ${left} change${left === 1 ? '' : 's'} stay local.` : ''}`
      : `Pushes the commits already on this branch to origin/${branch}.${left ? ` ${left} uncommitted change${left === 1 ? '' : 's'} stay local.` : ''}`;
    $('#push-message').disabled = !files.length;
    $('#push-go').disabled = pending || bad || needsMessage || !connected();
    $('#push-go').title = bad ? 'Enter a valid branch name' : needsMessage ? 'Write a commit message for the selected files' : '';
  }

  function render() {
    const source = $('#push-source');
    source.replaceChildren(...info.dirs.map((d) => Object.assign(document.createElement('option'), { value: d.id, textContent: d.name })));
    source.value = info.source;
    $('#push-prefix').textContent = info.prefix;
    if (!$('#push-branch').dataset.touched) $('#push-branch').value = info.branch.slice(info.prefix.length);
    $('#push-head').textContent = [info.current && `On ${info.current}`, info.head && `last commit ${info.head}`].filter(Boolean).join(' · ');
    const list = $('#push-files'); list.replaceChildren();
    if (!info.files.length) {
      const empty = document.createElement('p'); empty.className = 'push-note'; empty.textContent = 'No uncommitted changes in this folder.'; list.append(empty);
    }
    for (const f of info.files) {
      const row = document.createElement('label'); row.className = 'push-file';
      const skip = PRIVATE.test(f.path) ? 'looks private, not selected' : LOCAL.test(f.path) ? 'Tandem local file, not selected' : '';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: f.path, checked: !skip });
      const tag = Object.assign(document.createElement('b'), { textContent: f.status, className: `st-${f.status[0]}` });
      const name = Object.assign(document.createElement('span'), { textContent: f.path, title: f.path });
      row.append(box, tag, name);
      if (skip) row.append(Object.assign(document.createElement('em'), { textContent: skip, className: 'warn' }));
      list.append(row);
    }
    $('#push-all').disabled = !info.files.length;
    $('#push-all').checked = info.files.length > 0;
    summarize();
  }

  function load(source) {
    status('Reading changes…');
    send({ t: 'pushinfo', source });
  }

  $('#btn-push').addEventListener('click', () => {
    if (!connected()) { notify('Turn off Demo and connect to the local server to push.'); return; }
    info = null; pending = false;
    $('#push-branch').value = ''; delete $('#push-branch').dataset.touched;
    $('#push-message').value = ''; $('#push-files').replaceChildren(); $('#push-source').replaceChildren(); $('#push-summary').textContent = ''; $('#push-head').textContent = '';
    dialog.showModal();
    load(getSource());
    summarize();
  });
  $('#close-push').addEventListener('click', () => dialog.close());
  $('#push-source').addEventListener('change', () => { const source = $('#push-source').value; info = null; load(source); summarize(); });
  $('#push-branch').addEventListener('input', (e) => { e.target.dataset.touched = '1'; summarize(); });
  $('#push-message').addEventListener('input', summarize);
  $('#push-all').addEventListener('change', () => { boxes().forEach((b) => { b.disabled = !$('#push-all').checked; }); summarize(); });
  $('#push-files').addEventListener('change', summarize);
  $('#push-go').addEventListener('click', () => {
    if ($('#push-go').disabled) return;
    pending = true; status('Pushing…'); summarize();
    send({ t: 'push', source: $('#push-source').value, branch: `${info.prefix}${suffix()}`, message: $('#push-message').value, files: picked() });
  });

  return {
    receive(msg) {
      if (msg.t === 'pushinfo') {
        if (msg.error) { status(msg.error, true); return true; }
        info = msg; status(''); render();
        return true;
      }
      if (msg.t === 'push-done') {
        pending = false;
        if (msg.ok) { status(''); dialog.close(); } else { status(msg.error || 'Push failed.', true); summarize(); }
        return true;
      }
      return false;
    },
  };
}
