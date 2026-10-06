// How the screen is divided: the chat panel on the left, the instruments on the right, and the scene between.
// Both side panels can be dragged wider (double-click a handle to reset). Everything that sits in the middle
// (the 3D scene's visible area, the terminal, the child drawer) reads --lw and --rw, so it follows along.

import { $, clamp } from './state.js';

const LEFT_KEY = 'tandem:left-width';
const RIGHT_KEY = 'tandem:right-width';
const saved = (key) => { try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; } };

export function initLayout(app) {
  const { ui } = app;

  function layout() {
    const vw = window.innerWidth;
    const left = saved(LEFT_KEY), right = saved(RIGHT_KEY);
    const lw = vw < 700 ? vw : left ? clamp(340, left, Math.min(820, vw * 0.55)) : clamp(380, vw * 0.34, 600);
    // The right panel hides on narrow windows unless the user has chosen a width, and never takes more than the left leaves.
    const rw = vw <= 900 ? 0 : right ? clamp(300, right, Math.min(760, vw * 0.5, vw - lw - 320)) : vw > 1280 ? clamp(360, vw * 0.22, 460) : 0;
    const root = document.documentElement.style;
    root.setProperty('--lw', lw + 'px');
    root.setProperty('--rw', rw + 'px');
    app.panelWidths = { left: lw, right: rw };
    document.body.classList.toggle('no-right', rw === 0);
    app.scene.setInsets(ui.hidden ? 0 : lw - 40, ui.hidden ? 0 : Math.max(0, rw - 40));
  }
  app.layout = layout;
  window.addEventListener('resize', layout);

  /** Drag a handle to resize a panel. `fromEdge` turns the pointer position into a width. */
  function dragHandle(handle, key, fromEdge) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      document.body.classList.add('resizing');
      // Follow the pointer on the window rather than relying on pointer capture, so the drag also ends
      // cleanly when the pointer is released outside the window or the capture is lost.
      const move = (ev) => {
        if (ev.buttons === 0) return stop(); // released somewhere we did not see
        try { localStorage.setItem(key, String(Math.round(fromEdge(ev.clientX)))); } catch {}
        layout();
      };
      const stop = () => {
        document.body.classList.remove('resizing');
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop); window.addEventListener('blur', stop);
    });
    handle.addEventListener('dblclick', () => { try { localStorage.removeItem(key); } catch {} layout(); });
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 60 : 20;
      const now = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(key === LEFT_KEY ? '--lw' : '--rw')) || 0;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const grow = (e.key === 'ArrowRight') === (key === LEFT_KEY);
        try { localStorage.setItem(key, String(now + (grow ? step : -step))); } catch {}
        layout();
      }
    });
  }
  dragHandle($('#left-resize'), LEFT_KEY, (x) => x + 20);
  dragHandle($('#right-resize'), RIGHT_KEY, (x) => window.innerWidth - x + 20);

  app.setHidden = function setHidden(on) {
    ui.hidden = on;
    document.body.classList.toggle('hide-ui', on);
    $('#btn-ui').classList.toggle('on', on);
    $('#btn-ui').firstChild.textContent = on ? 'Show panels ' : 'Hide panels ';
    layout();
  };
}
