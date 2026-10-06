// The small toast near the bottom of the screen.

import { $ } from './state.js';

export function initNotice(app) {
  let timer;
  app.showNotice = (text) => {
    $('#notice').textContent = text; $('#notice').hidden = false;
    clearTimeout(timer); timer = setTimeout(() => ($('#notice').hidden = true), 9000);
  };
}
