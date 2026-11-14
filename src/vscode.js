// The VS Code panel: the real editor from the user's own VS Code install, shown in the side panel (see
// server/vscode.mjs). It starts only when asked, because starting it accepts Microsoft's server license terms and,
// the first time, downloads the server component. After that first yes it starts whenever the panel is opened.

const $ = (s) => document.querySelector(s);
const OK_KEY = 'tandem:vscode-accepted';
const agreed = () => { try { return localStorage.getItem(OK_KEY) === '1'; } catch { return false; } };

export function createVscodePanel({ send, connected, getSelected, isOpen }) {
  let agents = [];
  let source = 'repo';
  let shownUrl = '';
  let waiting = false;
  const frame = $('#vs-frame');
  const say = (text, bad = false) => { $('#vs-msg').textContent = text || ''; $('#vs-msg').classList.toggle('bad', !!bad); };

  function renderSources() {
    const select = $('#vs-source');
    select.replaceChildren(Object.assign(document.createElement('option'), { value: 'repo', textContent: 'Repository' }), Object.assign(document.createElement('option'), { value: 'shared', textContent: 'Shared folder (all agents)' }));
    for (const a of agents) select.append(Object.assign(document.createElement('option'), { value: a.id, textContent: `${a.name}'s worktree` }));
    if (![...select.options].some((o) => o.value === source)) source = 'repo';
    select.value = source;
  }
  function view(running) {
    $('#vs-start').hidden = running;
    frame.hidden = !running;
    for (const id of ['#vs-reload', '#vs-stop']) $(id).disabled = !running;
  }
  function open() {
    if (!connected()) return say('Not connected to Tandem.', true);
    waiting = true;
    say('Starting VS Code…');
    $('#vs-go').disabled = true;
    send({ t: 'vscode-open', source });
  }

  $('#vs-go').addEventListener('click', () => { try { localStorage.setItem(OK_KEY, '1'); } catch { /* asked again next time */ } open(); });
  $('#vs-source').addEventListener('change', (e) => { source = e.target.value; if (!frame.hidden || agreed()) open(); });
  $('#vs-reload').addEventListener('click', () => { shownUrl = ''; open(); });
  $('#vs-stop').addEventListener('click', () => { if (connected()) send({ t: 'vscode-stop' }); });
  $('#vs-desktop').addEventListener('click', () => { if (connected()) send({ t: 'open-editor', source }); });
  view(false);

  /**
   * Show VS Code's own terminal panel. The editor is served from Tandem's origin, so its page can be reached directly;
   * this presses its "Toggle Panel" button when the panel is closed. Returns false when the editor is not up yet.
   */
  function showTerminal() {
    let doc;
    try { doc = frame.contentDocument; } catch { return false; }
    const panel = doc?.querySelector('.part.panel');
    const toggle = [...(doc?.querySelectorAll('.action-label') || [])].find((el) => /^Toggle Panel/i.test(el.getAttribute('aria-label') || ''));
    if (!toggle) return false;
    if (!panel || panel.offsetParent === null) toggle.click();
    return true;
  }
  let terminalWanted = false;
  frame.addEventListener('load', () => {
    if (!terminalWanted) return;
    // The workbench builds itself after the page loads: look for its panel button for up to half a minute.
    let tries = 0;
    const timer = setInterval(() => { if (showTerminal() || ++tries > 60) { clearInterval(timer); terminalWanted = false; } }, 500);
  });

  return {
    /** True once this computer agreed to run the embedded editor. */
    agreed,
    /** Open the editor if needed and show its terminal. */
    terminal() { if (frame.hidden || !showTerminal()) terminalWanted = true; },
    /** The side panel started showing this view. The first time, the folder follows the selected agent. */
    shown() {
      renderSources();
      if (!shownUrl) { const sel = getSelected(); if (sel && agents.some((a) => a.id === sel)) { source = sel; renderSources(); } }
      if (agreed() && !shownUrl && !waiting) open();
    },
    /** Show another folder: the explorer's choice. Reloads the editor if it is running. */
    setSource(src) { if (src === source || !(src === 'repo' || src === 'shared' || agents.some((a) => a.id === src))) return; source = src; renderSources(); if (shownUrl) open(); },
    /** The server became reachable: start the editor now if the panel was opened before that. */
    online() { if (isOpen() && agreed() && !shownUrl && !waiting) open(); },
    setAgents(list) {
      agents = (list || []).filter((a) => a.provider !== 'api').map((a) => ({ id: a.id, name: a.name })); // API chats have no folder of their own
      renderSources();
    },
    /** Another project was opened: the editor follows it the next time it is on screen. */
    repoChanged() { source = 'repo'; renderSources(); if (shownUrl) { shownUrl = ''; if (isOpen()) open(); else { frame.removeAttribute('src'); view(false); } } },
    receive(msg) {
      if (msg.t !== 'vscode') return false;
      waiting = false;
      $('#vs-go').disabled = false;
      if (msg.stopped) { shownUrl = ''; frame.removeAttribute('src'); view(false); say('Stopped.'); return true; }
      if (msg.error) { say(msg.error, true); return true; }
      say(msg.name || '');
      if (msg.url !== shownUrl) { shownUrl = msg.url; frame.src = msg.url; }
      view(true);
      return true;
    },
  };
}
