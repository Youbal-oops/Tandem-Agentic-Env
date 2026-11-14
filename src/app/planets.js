// The planet view: an optional 3D picture of the agents (the sun is the repository, each agent is a planet), shown in
// the side panel. It is off by default. three.js and the scene are only downloaded and started the first time the view
// is opened, and the scene stops drawing whenever the view is not on screen, so a text-only session never pays for it.

import { AGENT_LOOK } from '../looks.js';
import { $ } from './state.js';

const SKY = ['ship', 'meteor', 'comet', 'asteroid'];

export function initPlanets(app) {
  const { AGENTS, panels, ui } = app;
  const labels = {}; // the name tag next to each planet
  const sunLabel = $('#plabels .sl');
  const box = new Map();
  let real = null; // the three.js scene, once loaded
  let loading = null;
  let eco = false;
  let skyN = 0;
  try { eco = localStorage.getItem('tandem:eco') === 'true'; } catch { /* default */ }

  function addLabel(id) {
    if (labels[id]) return;
    const el = document.createElement('div');
    el.className = 'pl'; el.dataset.agent = id; el.innerHTML = '<b></b><small></small>';
    el.querySelector('b').textContent = app.NAMES[id];
    el.style.color = AGENT_LOOK[id].hex;
    $('#plabels').append(el);
    labels[id] = el;
  }
  const measure = () => { for (const el of [...Object.values(labels), sunLabel]) box.set(el, { w: el.offsetWidth, h: el.offsetHeight }); };

  function updateLabels() {
    if (!app.planets.on) return;
    for (const a of AGENTS) {
      if (!labels[a]) continue;
      let [cls, text] = panels[a].state;
      const kids = (app.childChats?.activity(a) || []).filter((k) => k.busy);
      if (kids.length && (cls === 'ready' || cls === 'idle')) { cls = 'work'; text = `${kids.length} subagent${kids.length > 1 ? 's' : ''} working`; }
      else if (kids.length && cls === 'work') text += ` · ${kids.length} subagent${kids.length > 1 ? 's' : ''}`;
      labels[a].dataset.state = cls;
      const f = panels[a].meta.stats?.ctx;
      labels[a].querySelector('small').textContent = cls === 'ready' && f?.window ? `ctx ${Math.round((f.used / f.window) * 100)}%` : text;
    }
    measure();
  }
  app.updateLabels = updateLabels;
  app.measure = () => { if (app.planets.on) measure(); };
  setInterval(updateLabels, 500);

  const place = (el, x, y, above) => {
    const b = box.get(el) || { w: 0, h: 0 };
    el.style.transform = `translate(${Math.round(x - b.w / 2)}px, ${Math.round(above ? y - b.h : y)}px)`;
  };

  async function load() {
    loading ||= import('../scene.js');
    const { createScene } = await loading;
    if (real) return;
    real = createScene($('#stage'));
    app.scene = real;
    real.setEco(eco);
    real.setTopDown(true);
    for (const id of AGENTS) { real.addPlanet(id, AGENT_LOOK[id]); addLabel(id); }
    real.onPick((id) => (id === 'sun' ? app.openWorkspace() : id && app.select(id)));
    let hovered = null;
    real.onHover((id) => (hovered = id));
    real.onFrame(() => {
      for (const a of AGENTS) {
        const el = labels[a];
        if (!el) continue;
        const s = real.screen(a);
        place(el, s.x, s.y - Math.min(s.r, 260) * 2.7 - 14, true);
        el.style.opacity = s.visible && !(ui.sel === a && s.r > 70) ? (hovered && hovered !== a ? '0.45' : '1') : '0';
      }
      const s = real.screen('sun');
      place(sunLabel, s.x, s.y + Math.min(s.r, 220) + 18, false);
      sunLabel.style.opacity = s.visible && s.r < 200 ? '1' : '0';
    });
  }

  app.planets = {
    on: false,
    /** An agent was added or removed: the planet follows, if the scene exists. */
    add(id) { if (real) { real.addPlanet(id, AGENT_LOOK[id]); addLabel(id); } },
    remove(id) { labels[id]?.remove(); delete labels[id]; real?.removePlanet(id); },
  };

  async function show() {
    try { await load(); } catch (e) { app.showNotice(`The planet view could not start: ${e.message}`); app.side(null); return; }
    if (app.sideView() !== 'planets') return; // closed again while loading
    app.planets.on = true;
    real.setPaused(false);
    real.setSelected(null); // always the whole system: this view is a backdrop, the chat is where you work
    for (const id of AGENTS) app.syncScene(id);
    updateLabels();
  }
  function hide() {
    app.planets.on = false;
    real?.setPaused(true);
  }
  app.onSide((view) => {
    const on = view === 'planets';
    $('#btn-planets').setAttribute('aria-pressed', String(on));
    $('#btn-planets').firstElementChild.textContent = on ? 'on' : 'off';
    if (on) show(); else hide();
  });

  function setEco(value) {
    eco = value;
    real?.setEco(eco);
    $('#btn-eco').classList.toggle('on', eco);
    try { localStorage.setItem('tandem:eco', String(eco)); } catch { /* the choice just will not persist */ }
  }
  $('#btn-eco').addEventListener('click', () => setEco(!eco));
  $('#btn-sky').addEventListener('click', () => real?.sky(SKY[skyN++ % SKY.length]));
  setEco(eco);
}
