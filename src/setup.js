// The first-run setup: sign in with accounts. The server installs what is missing, starts each browser sign-in and tells us when
// it is finished (server/account-setup.mjs); this only shows the state and sends the clicks.

const $ = (s) => document.querySelector(s);

export function createSetup({ send, connected }) {
  let providers = [];
  const list = () => $('#setup-accounts');

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const button = (text, onClick, primary = false) => { const b = el('button', primary ? 'primary' : '', text); b.type = 'button'; b.addEventListener('click', onClick); return b; };

  function card(p) {
    const busy = p.phase === 'installing' || p.phase === 'signing-in';
    const connectedNow = p.signedIn && !busy;
    const row = el('article', `acct${connectedNow ? ' done' : ''}`);
    const main = el('div', 'acct-main');
    main.append(el('b', '', p.account), el('small', '', busy ? (p.step || (p.phase === 'installing' ? 'Installing…' : 'Waiting for you to sign in…')) : p.about));
    if (p.phase === 'installing') { const bar = el('div', `acct-bar${p.percent === null ? ' wait' : ''}`); const i = el('i'); if (p.percent !== null) i.style.width = `${p.percent}%`; bar.append(i); main.append(bar); }
    if (p.phase === 'signing-in') main.append(el('div', 'acct-bar wait')); // a moving bar: it waits for you, not for Tandem
    if (p.phase === 'error' && p.error) main.append(el('small', 'err', p.error));
    const act = el('div', 'acct-act');
    if (busy) {
      if (p.phase === 'signing-in' && p.url) act.append(button('Open sign-in page', () => window.open(p.url, '_blank', 'noopener')));
      act.append(button('Cancel', () => send({ t: 'setup-cancel', cli: p.id })));
    } else if (connectedNow) act.append(el('span', 'acct-ok', '✓ Connected'));
    else if (!p.installed && !p.canInstall) act.append(el('small', '', 'Install it from its own website, then reopen this.'));
    else act.append(button(p.phase === 'error' ? 'Try again' : p.installed ? 'Sign in' : 'Set up', () => { if (connected()) send({ t: 'setup-begin', cli: p.id }); }, true));
    row.append(main, act);
    return row;
  }

  function render() {
    list().replaceChildren(...providers.map(card));
    const any = providers.some((p) => p.signedIn);
    $('#setup-hint').textContent = any ? '' : 'You can also skip this and connect an account later from Set up.';
    $('#finish-setup').textContent = any ? 'Start working →' : 'Skip for now →';
  }

  const refresh = () => { if (connected()) send({ t: 'setup-state' }); };
  return {
    open() { render(); refresh(); },
    receive(msg) {
      if (msg.t === 'setup-state') { providers = msg.providers; render(); return true; }
      if (msg.t === 'setup') { // one provider changed
        const i = providers.findIndex((p) => p.id === msg.provider.id);
        if (i >= 0) { providers[i] = { ...providers[i], ...msg.provider }; if (msg.provider.phase === 'done') providers[i].signedIn = providers[i].installed = true; render(); }
        return true;
      }
      if (msg.t === 'connect-changed') { if ($('#setup-dialog').open) refresh(); return false; }
      return false;
    },
  };
}
