// How the window is divided: the sidebar on the left, the chat in the middle, and an optional side panel on the right
// that shows one thing at a time (the code view, activity, or the planet view). The side panel is closed by default,
// can be dragged wider (double-click the handle to reset), and remembers its width per view.

import { $, clamp } from './state.js';

const VIEW_KEY = 'tandem:side';
const RAIL_KEY = 'tandem:rail-hidden';
const VIEWS = ['review', 'code', 'vscode', 'activity', 'planets'];
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, String(value)); } catch { /* the choice just will not persist */ } };

export function initLayout(app) {
  let view = null;
  const wide = () => view === 'code' || view === 'vscode' || view === 'review'; // the two editors want most of the window
  const widthKey = () => `tandem:side-width:${wide() ? 'code' : 'panel'}`;
  const listeners = [];
  /** Call `fn(view, previous)` whenever the side panel changes what it shows. */
  app.onSide = (fn) => listeners.push(fn);
  app.sideView = () => view;

  function layout() {
    if (!view) return;
    const vw = window.innerWidth;
    const rail = $('#rail').offsetWidth;
    const saved = Number(read(widthKey())) || 0;
    const fallback = wide() ? (vw - rail) * 0.6 : 420;
    // The chat always keeps at least 360px; below that the side panel takes the whole area (see the narrow layout in shell.css).
    const width = clamp(320, saved || fallback, Math.max(320, vw - rail - 360));
    document.documentElement.style.setProperty('--side', Math.round(width) + 'px');
  }
  app.layout = layout;
  window.addEventListener('resize', layout);

  /** Show one view in the side panel, or close it with `null`. */
  app.side = function side(next) {
    if (next && !VIEWS.includes(next)) return;
    const previous = view;
    view = next || null;
    write(VIEW_KEY, view);
    $('#side').hidden = $('#side-resize').hidden = !view;
    document.body.dataset.side = view || '';
    document.querySelectorAll('[data-side-page]').forEach((page) => { page.hidden = page.dataset.sidePage !== view; });
    $('#side-title').textContent = { review: 'Review', code: 'Code', vscode: 'VS Code', activity: 'Activity', planets: 'Planets' }[view] || '';
    document.querySelectorAll('[data-side]').forEach((tab) => tab.classList.toggle('on', tab.dataset.side === view));
    $('#btn-code').classList.toggle('on', view === 'code');
    $('#btn-activity').classList.toggle('on', view === 'activity');
    $('#btn-editor').classList.toggle('on', view === 'vscode');
    $('#btn-review').classList.toggle('on', view === 'review');
    layout();
    for (const fn of listeners) fn(view, previous);
  };
  app.toggleSide = (name) => app.side(view === name ? null : name);

  app.setRail = function setRail(hidden) {
    document.body.classList.toggle('rail-off', hidden);
    write(RAIL_KEY, hidden ? '1' : null);
    layout();
  };
  app.railHidden = () => document.body.classList.contains('rail-off');

  // Drag the handle to resize. The pointer is followed on the window, so the drag also ends cleanly when the button is
  // released outside the window.
  const handle = $('#side-resize');
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    document.body.classList.add('resizing');
    const move = (ev) => {
      if (ev.buttons === 0) return stop();
      write(widthKey(), Math.round(window.innerWidth - ev.clientX));
      layout();
    };
    const stop = () => {
      document.body.classList.remove('resizing');
      for (const type of ['pointermove', 'pointerup', 'pointercancel', 'blur']) window.removeEventListener(type, type === 'pointermove' ? move : stop);
    };
    window.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(type, stop);
  });
  handle.addEventListener('dblclick', () => { write(widthKey(), null); layout(); });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const now = $('#side').offsetWidth;
    write(widthKey(), now + (e.key === 'ArrowLeft' ? 1 : -1) * (e.shiftKey ? 60 : 20));
    layout();
  });

  /** Put the window back the way it was left: the sidebar, and whichever side view was open. */
  app.restoreLayout = () => {
    app.setRail(read(RAIL_KEY) === '1');
    const saved = read(VIEW_KEY);
    if (VIEWS.includes(saved)) app.side(saved);
  };
}
