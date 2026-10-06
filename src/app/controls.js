// The top bar and keyboard: overview, hide panels, demo, eco/lite/theme switches, the clock and the Alt shortcuts.

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
  $('#btn-theme').textContent = app.theme === 'forest' ? 'Theme: Solar system' : 'Theme: Sunset cats';
  $('#btn-theme').addEventListener('click', () => {
    localStorage.setItem('tandem:theme', app.theme === 'forest' ? 'space' : 'forest');
    location.reload();
  });
  setEco(eco);

  $('#btn-overview').addEventListener('click', () => { scene.setTopDown(true); app.select(null); });
  $('#btn-ui').addEventListener('click', () => app.setHidden(!ui.hidden));
  $('#btn-demo').addEventListener('click', () => app.setDemo(!ui.demo));
  $('#btn-sky').addEventListener('click', () => scene.sky(SKY[skyN++ % SKY.length]));
  scene.onPick((id) => (id === 'sun' ? app.openWorkspace() : app.select(id && id !== ui.sel ? id : null)));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;
      app.select(null);
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const actions = { 1: () => app.select('claude'), 2: () => app.select('codex'), 0: () => app.select(null), h: () => app.setHidden(!ui.hidden), d: () => app.setDemo(!ui.demo), k: () => scene.sky(SKY[skyN++ % SKY.length]) };
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
