// The name tags that float next to the planets and the sun in the 3D scene.

import { $ } from './state.js';

export function initLabels(app) {
  const { AGENTS, panels, ui } = app;
  app.labelEls = Object.fromEntries(AGENTS.map((a) => [a, $(`.pl[data-agent="${a}"]`)]));
  const labelEls = app.labelEls;
  const sunEl = $('.sl');
  const box = new Map();

  function measure() {
    for (const el of [...Object.values(labelEls), sunEl]) box.set(el, { w: el.offsetWidth, h: el.offsetHeight });
  }
  app.measure = measure;

  app.updateLabels = function updateLabels() {
    for (const a of AGENTS) {
      let [cls, text] = panels[a].state;
      const kids = (app.childChats?.activity(a) || []).filter((k) => k.busy);
      if (kids.length && (cls === 'ready' || cls === 'idle')) { cls = 'work'; text = `${kids.length} subagent${kids.length > 1 ? 's' : ''} working`; }
      else if (kids.length && cls === 'work') text += ` · ${kids.length} subagent${kids.length > 1 ? 's' : ''}`;
      labelEls[a].dataset.state = cls;
      const f = panels[a].meta.stats?.ctx;
      $('small', labelEls[a]).textContent = cls === 'ready' && f?.window ? `ctx ${Math.round((f.used / f.window) * 100)}%` : text;
    }
    measure();
  };

  const place = (el, x, y, anchor) => {
    const b = box.get(el) || { w: 0, h: 0 };
    el.style.transform = `translate(${Math.round(x - b.w / 2)}px, ${Math.round(anchor === 'above' ? y - b.h : y)}px)`;
  };
  // Labels vanish when they would sit underneath a side panel.
  // The panel widths only change in layout(), which stores them on `app`, so this is cheap enough to run every frame.
  const clear = (x) => {
    const lw = ui.hidden ? 0 : (app.panelWidths?.left ?? 0) - 30;
    const rw = ui.hidden ? 0 : (app.panelWidths?.right ?? 0) - 30;
    return x > lw + 40 && x < window.innerWidth - Math.max(rw, 0) - 40;
  };

  let hovered = null;
  app.scene.onHover((id) => (hovered = id));
  app.scene.onFrame(() => {
    if (app.theme === 'forest') return;
    for (const a of AGENTS) {
      const s = app.scene.screen(a);
      const el = labelEls[a];
      place(el, s.x, s.y - Math.min(s.r, 260) * (ui.sel === a ? 2.6 : 2.7) - 14, 'above');
      el.style.opacity = s.visible && clear(s.x) && !(ui.sel === a && s.r > 70) ? (hovered && hovered !== a ? '0.45' : '1') : '0';
    }
    const s = app.scene.screen('sun');
    place(sunEl, s.x, s.y + Math.min(s.r, 220) + 18, 'below');
    sunEl.style.opacity = s.visible && s.r < 200 && clear(s.x) ? '1' : '0';
  });
  setInterval(app.updateLabels, 500);
}
