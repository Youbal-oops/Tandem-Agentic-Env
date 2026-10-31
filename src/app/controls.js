// The top bar and keyboard: overview, hide panels, demo, eco/lite switches, the terminal and editor buttons, the clock and the Alt shortcuts.

import { $ } from './state.js';

const SKY = ['ship', 'meteor', 'comet', 'asteroid'];

export function initControls(app) {
  const { ui, scene } = app;
  let skyN = 0;
  let eco = localStorage.getItem('tandem:eco') === 'true';

  function setEco(on) { eco = on; scene.setEco(on); $('#btn-eco').classList.toggle('on', on); localStorage.setItem('tandem:eco', on); }
  $('#btn-eco').addEventListener('click', () => setEco(!eco));
  $('#btn-lite').classList.toggle('on', app.lite);
  $('#btn-lite').addEventListener('click', () => { localStorage.setItem('tandem:lite', !app.lite); location.reload(); });
  setEco(eco);

  $('#btn-overview').addEventListener('click', () => { scene.setTopDown(true); app.select(null); });
  $('#btn-ui').addEventListener('click', () => app.setHidden(!ui.hidden));
  $('#btn-demo').addEventListener('click', () => app.setDemo(!ui.demo));
  $('#btn-sky').addEventListener('click', () => scene.sky(SKY[skyN++ % SKY.length]));
  scene.onPick((id) => (id === 'sun' ? app.openWorkspace() : app.select(id && id !== ui.sel ? id : null)));

  // The real terminal and editor open as their own windows, in the selected agent's worktree or else the repository.
  const openTool = (t) => (app.net.open ? app.net.send({ t, source: ui.sel || 'repo' }) : app.showNotice('Connect to the server first.'));
  $('#btn-terminal').addEventListener('click', () => openTool('open-terminal'));
  $('#btn-editor').addEventListener('click', () => openTool('open-editor'));
  // Each agent has its own browser window; this brings the selected agent's (or the only agent's) forward.
  $('#btn-browser').addEventListener('click', () => {
    const id = ui.sel || (app.AGENTS.length === 1 ? app.AGENTS[0] : null);
    if (!id) return app.showNotice('Select an agent first: each agent has its own browser window.');
    if (!app.net.open) return app.showNotice('Connect to the server first.');
    app.net.send({ t: 'show-browser', source: id });
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      if (e.key === '`' || e.code === 'Backquote') { e.preventDefault(); openTool('open-terminal'); return; }
      if (e.key.toLowerCase() === 'e' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) { e.preventDefault(); openTool('open-editor'); return; }
    }
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;
      app.select(null);
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const actions = { ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, () => { if (app.AGENTS[n - 1]) app.select(app.AGENTS[n - 1]); }])), 0: () => app.select(null), h: () => app.setHidden(!ui.hidden), d: () => app.setDemo(!ui.demo), k: () => scene.sky(SKY[skyN++ % SKY.length]) };
    if (actions[k]) {
      e.preventDefault();
      actions[k]();
    }
  });

  // The "More" menu closes after a choice or a click elsewhere.
  document.querySelectorAll('.toolbar-menu button').forEach((button) => button.addEventListener('click', () => { button.closest('details').open = false; }));
  document.addEventListener('click', (e) => { const menu = document.querySelector('.toolbar-more'); if (!menu.contains(e.target)) menu.open = false; });

  // ---------------------------------------------------------------- clock
  function tickClock() {
    const now = new Date();
    $('#clock').textContent = now.toTimeString().slice(0, 8);
    const s = Math.floor((Date.now() - app.bootAt) / 1000);
    $('#uptime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  /** `?sky` in the address bar plays every sky event once, for a quick look. */
  app.playSky = () => SKY.forEach((k, i) => setTimeout(() => scene.sky(k), i * 600));
}
