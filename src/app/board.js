// The departures-board style "work board" along the bottom: one row per recent task, with flip-flap letters.

import { AGENT_LOOK } from '../looks.js';
import { $ } from './state.js';

const ST = {
  running: ['WORKING', null],
  awaiting: ['NEEDS OK', '#ffd27a'],
  done: ['DONE', '#7ee0a3'],
  error: ['FAILED', '#ff6b6b'],
  denied: ['DENIED', '#ffd27a'],
};
const flap = (text) => [...text].map((c) => `<span>${c === ' ' ? '&nbsp;' : c}</span>`).join('');

export function initBoard(app) {
  const board = new Map();
  let boardNo = 400;

  app.boardSet = function boardSet(key, agent, route, state) {
    const [label, color] = ST[state] || ST.running;
    let row = board.get(key);
    if (!row) {
      const el = document.createElement('div');
      el.className = 'brow';
      el.style.setProperty('--c', AGENT_LOOK[agent].hex);
      const code = `${app.CODES[agent]}${String(++boardNo % 1000).padStart(3, '0')}`;
      el.innerHTML = `<span class="flap hot">${flap(code)}</span><span class="route"></span><span class="flap st"></span>`;
      $('.route', el).textContent = route;
      el.addEventListener('click', () => app.select(agent));
      const box = $('#ticker-items');
      box.querySelector('.idle')?.remove();
      box.prepend(el);
      row = { el, st: '' };
      board.set(key, row);
      while (box.children.length > 3) {
        const last = box.lastElementChild;
        for (const [k, r] of board) if (r.el === last) board.delete(k);
        last.remove();
      }
    }
    if (row.st !== state) {
      const st = $('.st', row.el);
      st.innerHTML = flap(label);
      st.classList.toggle('hot', state !== 'done');
      st.classList.remove('flip');
      void st.offsetWidth;
      st.classList.add('flip');
      st.style.setProperty('--c', color || AGENT_LOOK[agent].hex);
      row.st = state;
    }
  };
}
