// Connecting an AI: one row per account (Claude, ChatGPT, Google) with one Connect button. The server installs what is missing,
// starts the browser sign-in and says when it is finished (server/account-setup.mjs); this shows the state and sends the click.
// The same rows appear in the Connect dialog and on the empty first screen.

const $ = (s) => document.querySelector(s);

export function createSetup({ send, connected }) {
  let providers = [];

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const button = (text, onClick, primary = false) => { const b = el('button', primary ? 'primary' : '', text); b.type = 'button'; b.addEventListener('click', onClick); return b; };

  function card(p) {
    const busy = p.phase === 'installing' || p.phase === 'signing-in';
    const ready = p.signedIn && !busy;
    const row = el('article', `acct${ready ? ' done' : ''}`);
    const main = el('div', 'acct-main');
    const add = ready && p.hasAgent === false; // signed in, but no agent for it here (it was removed, or never added)
    const line = p.checking ? 'Checking…' : busy ? (p.step || (p.phase === 'installing' ? 'Getting it ready…' : 'Finish signing in in your browser…')) : ready ? 'Ready to use' : `Sign in with your ${p.account}`;
    main.append(el('b', '', p.name), el('small', '', line));
    if (busy) { const bar = el('div', `acct-bar${p.phase === 'installing' && p.percent !== null ? '' : ' wait'}`); const i = el('i'); if (p.phase === 'installing' && p.percent !== null) i.style.width = `${p.percent}%`; bar.append(i); main.append(bar); }
    if (p.phase === 'error' && p.error) main.append(el('small', 'err', p.error));
    const act = el('div', 'acct-act');
    if (busy) {
      if (p.phase === 'signing-in' && p.url) act.append(button('Open sign-in page', () => window.open(p.url, '_blank', 'noopener')));
      act.append(button('Cancel', () => send({ t: 'setup-cancel', cli: p.id })));
    } else if (p.checking) act.append(el('span', 'acct-loading', ''));
    else if (add) act.append(button('Add', () => { if (connected()) send({ t: 'setup-begin', cli: p.id }); }, true));
    else if (ready) act.append(el('span', 'acct-ok', '✓ Connected'));
    else if (!p.installed && !p.canInstall) act.append(el('small', '', 'Not available on this computer yet'));
    else act.append(button(p.phase === 'error' ? 'Try again' : 'Connect', () => { if (connected()) send({ t: 'setup-begin', cli: p.id }); }, true));
    row.append(main, act);
    return row;
  }

  function render() {
    for (const list of document.querySelectorAll('.acct-list')) list.replaceChildren(...(providers.length ? providers.map(card) : [el('small', 'acct-loading', 'Checking this computer…')]));
  }

  // Asked as soon as the connection is up (the first screen opens a moment before it is).
  let tries = 0;
  const refresh = () => { if (connected()) { tries = 0; send({ t: 'setup-state' }); } else if (tries++ < 40) setTimeout(refresh, 250); };
  return {
    open() { render(); refresh(); },
    /** The agents changed (one was added or removed): each row's Connected / Add follows at once. */
    agentsChanged(list) { const have = new Set((list || []).map((a) => a.provider)); providers = providers.map((p) => ({ ...p, hasAgent: have.has(p.id) })); render(); },
    receive(msg) {
      if (msg.t === 'setup-state') { // a quick first answer never replaces a full one that is already shown
        if (!msg.providers.some((p) => p.checking) || !providers.length) providers = msg.providers;
        else providers = providers.map((old) => ({ ...old, hasAgent: msg.providers.find((p) => p.id === old.id)?.hasAgent ?? old.hasAgent }));
        render(); return true;
      }
      if (msg.t === 'setup') { // one account changed
        const i = providers.findIndex((p) => p.id === msg.provider.id);
        if (i >= 0) { providers[i] = { ...providers[i], ...msg.provider }; if (msg.provider.phase === 'done') { providers[i].signedIn = providers[i].installed = true; providers[i].hasAgent = true; providers[i].checking = false; } render(); }
        return true;
      }
      if (msg.t === 'connect-changed') { refresh(); return true; }
      if (msg.t === 'connect-install' || msg.t === 'connect-status') return true; // the old dialog's messages: nothing shows them now
      return false;
    },
  };
}
