// "Connect agents": see which agent CLIs are installed and signed in, install one with a button, open its
// sign-in in a real terminal window, and add it as a planet. The server decides what may run; this only asks.

const $ = (s) => document.querySelector(s);

export function createConnectDialog({ send, connected, notify }) {
  const dialog = $('#connect-dialog');
  let installing = null;

  const badge = (text, kind) => { const b = document.createElement('span'); b.className = `connect-badge ${kind}`; b.textContent = text; return b; };
  const button = (text, onClick, { primary = false, disabled = false } = {}) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.disabled = disabled;
    if (primary) b.classList.add('primary');
    b.addEventListener('click', onClick);
    return b;
  };
  const refresh = () => { $('#connect-status').textContent = 'Checking…'; send({ t: 'connect-status' }); };

  function render(msg) {
    installing = msg.installing || null;
    $('#connect-status').textContent = '';
    $('#connect-npm').hidden = msg.npm !== false;
    const list = $('#connect-list'); list.replaceChildren();
    for (const c of msg.clis) {
      const row = document.createElement('article'); row.className = 'connect-row';
      const head = document.createElement('div'); head.className = 'connect-head';
      const name = document.createElement('b'); name.textContent = c.name;
      head.append(name);
      if (c.installed) head.append(badge(c.version || 'installed', 'ok'));
      else head.append(badge('not installed', 'off'));
      if (c.installed) head.append(c.signedIn === true ? badge('signed in', 'ok') : badge('not signed in', 'warn'));
      const actions = document.createElement('div'); actions.className = 'connect-actions';
      if (!c.installed) actions.append(button(c.installing || installing === c.id ? 'Installing…' : 'Install', () => {
        if (!connected()) return notify('Connect to the local server first.');
        $('#connect-log').hidden = false; $('#connect-log').textContent = '';
        send({ t: 'connect-install', cli: c.id });
      }, { primary: true, disabled: !!installing || msg.npm === false }));
      if (c.installed && c.signedIn !== true) actions.append(button('Sign in', () => send({ t: 'connect-login', cli: c.id }), { primary: true }));
      if (c.installed) actions.append(button('Add as a planet', () => send({ t: 'addagent', config: { name: c.name.replace(/ CLI$| Code$/, ''), provider: c.id } })));
      row.append(head, actions);
      list.append(row);
    }
  }

  function open() {
    if (!connected()) return notify('Connect to the local server first.');
    $('#connect-log').hidden = true;
    dialog.showModal();
    refresh();
  }
  $('#btn-connect').addEventListener('click', open);
  $('#open-connect')?.addEventListener('click', () => { $('#workspace-dialog').close(); open(); });
  $('#close-connect').addEventListener('click', () => dialog.close());
  $('#connect-refresh').addEventListener('click', refresh);

  return {
    receive(msg) {
      if (msg.t === 'connect-status') { render(msg); return true; }
      if (msg.t === 'connect-install') {
        const log = $('#connect-log');
        if (msg.kind === 'started') { installing = msg.cli; log.hidden = false; return true; }
        log.hidden = false;
        log.textContent = (log.textContent + (msg.text || '')).slice(-20000);
        if (msg.kind === 'done') { log.textContent += '\n' + msg.text + '\n'; installing = null; }
        log.scrollTop = log.scrollHeight;
        return true;
      }
      if (msg.t === 'connect-changed') { if (dialog.open) refresh(); return true; }
      return false;
    },
  };
}
