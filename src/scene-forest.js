// Sunset carriage with illustrated, agent-driven cats and subagent kittens.
import { AGENT_LOOK, CLASS_COLORS } from './looks.js';
import { createTandemCatStage } from './tandem-cat-stage.js';
export { AGENT_LOOK, CLASS_COLORS };

const W = 1600, H = 1000;
const TAU = Math.PI * 2;
const rand = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const windows = [[166, 167, 205, 407], [625, 165, 421, 409], [1100, 165, 421, 409]];
function rounded(c, x, y, w, h, r, fill, stroke) {
  c.beginPath(); c.roundRect(x, y, w, h, r);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.stroke(); }
}
function ellipse(c, x, y, rx, ry, fill, stroke) {
  c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, TAU);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.stroke(); }
}
function path(c, d, fill, stroke) {
  const p = new Path2D(d);
  if (fill) { c.fillStyle = fill; c.fill(p); }
  if (stroke) { c.strokeStyle = stroke; c.stroke(p); }
}
function gradient(c, x, y, xx, yy, stops) {
  const g = c.createLinearGradient(x, y, xx, yy);
  stops.forEach(([p, color]) => g.addColorStop(p, color)); return g;
}
function leaf(c, x, y, size, angle, color) {
  c.save(); c.translate(x, y); c.rotate(angle); c.scale(size, size);
  path(c, 'M0 0 Q-11 -8 -8 -25 Q8 -22 0 0', color);
  c.restore();
}
function vines(c, front = false) {
  const stems = front ? [[0, -35, 800], [1570, 0, 950], [80, -40, 300]]
    : [[285, 5, 260], [354, 0, 660], [1180, 0, 320], [1490, 30, 785], [554, 528, 407], [210, 675, 330]];
  stems.forEach(([x, y, length], j) => {
    const points = Math.floor(length / 19);
    c.beginPath(); c.moveTo(x, y);
    for (let i = 1; i < points; i++) c.lineTo(x + Math.sin(i * .39 + j) * (front ? 57 : 25), y + i * 19);
    c.strokeStyle = front ? '#261915' : '#583829'; c.lineWidth = front ? 5 : 2; c.stroke();
    for (let i = 1; i < points; i++) {
      const px = x + Math.sin(i * .39 + j) * (front ? 57 : 25), py = y + i * 19;
      for (const side of [-1, 1]) {
        const size = (front ? 2.3 : 1.1) * (.65 + rand(i + j * 44) * .75);
        leaf(c, px, py, size, side * (1.1 + rand(i * 7) * .8), front ? '#2b1b17' : ['#433024', '#715038', '#97613a'][i % 3]);
      }
    }
  });
  // Overgrown ceiling rail.
  for (let i = 0; i < 84; i++) {
    const x = i * 20;
    leaf(c, x, 39 + Math.sin(i * .2) * 23, 1.2 + rand(i) * .8, .6 + rand(i + 9) * 2.8, '#3f2920');
  }
}
function drawInterior(c) {
  c.fillStyle = gradient(c, 0, 0, 1400, 900, [[0, '#583329'], [.38, '#a76143'], [1, '#663b31']]);
  c.fillRect(0, 0, W, H);
  // Recessed ceiling, seams and luggage rack.
  path(c, 'M0 0 H1600 L1490 110 H140 L0 0', '#6b4435');
  for (let i = 0; i < 56; i++) {
    c.strokeStyle = '#492c26'; c.lineWidth = 5;
    c.beginPath(); c.moveTo(i * 31 - 40, 23); c.lineTo(i * 28 + 15, 88); c.stroke();
  }
  rounded(c, 132, 107, 1410, 13, 5, '#c28a61');
  rounded(c, 127, 122, 1418, 9, 4, '#55342c');
  // Door on the left and a faded route map between windows.
  c.strokeStyle = '#583126'; c.lineWidth = 4; c.strokeRect(105, 130, 299, 796);
  rounded(c, 430, 167, 144, 116, 3, '#593329', '#bc8054');
  c.fillStyle = '#b17a52'; c.font = '11px Georgia'; c.fillText('THE LONG WAY HOME', 442, 192);
  c.strokeStyle = '#ae774f'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(447, 229); c.lineTo(558, 229); c.stroke();
  for (let i = 0; i < 6; i++) ellipse(c, 450 + i * 20, 229, 3, 3, '#c89661');
  c.font = '9px Georgia'; c.fillText('TAKE YOUR TIME', 458, 257);
  rounded(c, 451, 307, 90, 53, 2, '#bf8659', '#713a2b');
  c.fillStyle = '#79422e'; c.font = '10px Georgia'; c.fillText('a little rest', 469, 331); c.fillText('a little wonder', 460, 346);
  for (const [x, y, w, h] of windows) {
    rounded(c, x - 21, y - 22, w + 42, h + 44, 51, '#b67a56');
    rounded(c, x - 13, y - 13, w + 26, h + 26, 43, '#3c241f');
    rounded(c, x - 5, y - 5, w + 10, h + 10, 35, '#1f1916');
    // The sky is drawn into these openings each frame.
    rounded(c, x + 38, y - 29, 23, 22, 2, '#956c50');
    rounded(c, x + w - 63, y - 29, 23, 22, 2, '#956c50');
  }
  // Bench back, piping, front cushion and a perforated heater grille.
  rounded(c, 303, 604, 1320, 229, 40, '#4e2b25');
  rounded(c, 312, 612, 1304, 208, 34, gradient(c, 0, 610, 0, 820, [[0, '#b96d47'], [.4, '#c97848'], [1, '#8f472e']]));
  for (const x of [616, 960, 1280]) {
    c.strokeStyle = '#87452f'; c.lineWidth = 3; c.beginPath(); c.moveTo(x, 620); c.quadraticCurveTo(x - 12, 718, x, 810); c.stroke();
  }
  rounded(c, 292, 807, 1340, 89, 27, gradient(c, 0, 807, 0, 896, [[0, '#df9253'], [.2, '#d57e43'], [1, '#9c4c2c']]));
  rounded(c, 300, 882, 1300, 12, 5, '#e99d5a');
  rounded(c, 322, 899, 1290, 101, 4, '#9c6140');
  c.fillStyle = '#653f2e';
  for (let row = 0; row < 9; row++) for (let col = 0; col < 109; col++) {
    const x = 337 + col * 12 + (row % 2) * 6, y = 918 + row * 10;
    c.fillRect(x - 2, y, 5, 1.5); c.fillRect(x, y - 2, 1.5, 5);
  }
  // Amber light projected across the upholstery.
  c.save(); c.globalCompositeOperation = 'screen'; c.globalAlpha = .37;
  path(c, 'M360 569 L492 569 L599 899 L316 899 L316 723 Z', '#ff9b28');
  path(c, 'M651 582 L963 582 L1108 891 L719 891 Z', '#ff9628');
  path(c, 'M1125 582 L1372 582 L1502 894 L1254 894 Z', '#ffa736');
  c.restore();
  // Tubular armrest.
  c.lineCap = 'round'; c.lineWidth = 16; c.strokeStyle = '#5c3b2b';
  c.beginPath(); c.moveTo(286, 866); c.lineTo(286, 700); c.quadraticCurveTo(284, 654, 328, 653); c.lineTo(364, 653); c.stroke();
  c.lineWidth = 6; c.strokeStyle = '#d9a269'; c.stroke();
  vines(c);
}
function drawSky(c, t) {
  for (const [x, y, w, h] of windows) {
    c.save(); rounded(c, x, y, w, h, 31); c.clip();
    c.fillStyle = gradient(c, 0, 150, 0, 580, [[0, '#f19451'], [.45, '#ffb969'], [1, '#f8c681']]); c.fillRect(x, y, w, h);
    ellipse(c, 1230, 402, 44, 44, '#ffda91');
    // Clouds share world coordinates, so they continue naturally between windows.
    for (let i = 0; i < 19; i++) {
      const cx = ((i * 163 + t * (2.0 + i % 3 * .7)) % 1950) - 180;
      const cy = 209 + rand(i + 7) * 253;
      const scale = .6 + rand(i + 8) * 1.5;
      c.save(); c.translate(cx, cy); c.scale(scale, scale); c.globalAlpha = .18;
      path(c, 'M-95 10 Q-110 -1 -83 -9 Q-80 -29 -54 -19 Q-35 -48 -7 -29 Q10 -48 38 -24 Q64 -27 68 -8 Q106 -7 94 10 Q30 25 -95 10', '#a85e39');
      c.globalAlpha = .19; path(c, 'M-79 -10 Q-78 -24 -54 -19 Q-35 -43 -7 -29 Q10 -43 38 -24 Q55 -25 65 -10 Q20 -18 -79 -10', '#ffedb6'); c.restore();
    }
    path(c, 'M0 545 Q120 502 230 523 Q365 471 490 511 Q639 499 779 525 Q951 473 1093 515 Q1230 477 1356 504 Q1482 456 1600 507 V600 H0 Z', '#bb784c');
    path(c, 'M0 565 Q218 523 410 557 Q632 519 800 555 Q1000 530 1200 550 Q1430 514 1600 535 V600 H0 Z', '#a86a43');
    c.strokeStyle = '#ae754a'; c.lineWidth = 2;
    for (const yy of [466, 477, 506]) { c.beginPath(); c.moveTo(0, yy); c.lineTo(1600, yy - 17); c.stroke(); }
    const pole = 1600 - (t * 7 % 1900); c.fillStyle = '#936140'; c.fillRect(pole, 434, 8, 180); c.fillRect(pole - 27, 464, 60, 5);
    // Soft diagonal reflection on the glass.
    path(c, `M${x + w - 65} ${y} h25 L${x} ${y + 210} v-22 Z`, '#ffffff10');
    c.restore();
    rounded(c, x - 2, y + 101, w + 4, 17, 2, '#58382a');
    rounded(c, x, y + 102, w, 3, 1, '#b78457');
  }
}

export function createScene(host) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Sunset train interior with slowly drifting clouds');
  canvas.setAttribute('role', 'img'); host.append(canvas);
  const ctx = canvas.getContext('2d');
  const background = document.createElement('canvas'); background.width = W; background.height = H;
  drawInterior(background.getContext('2d'));
  const foreground = document.createElement('canvas'); foreground.width = W; foreground.height = H;
  vines(foreground.getContext('2d'), true);
  const agents = new Set(Object.keys(AGENT_LOOK)), hooks = new Set();
  let pickHandler = () => {}, hoverHandler = () => {};
  const cats = createTandemCatStage(host, { assetUrl: '/models/tandem_cat.glb', autoRender: false, fit: 'cover', baseline: 116, scale: 44, positions: [680, 1165], onPick: id => pickHandler(id), onHover: id => hoverHandler(id) });
  for (const id of agents) cats.syncAgent(id, {}, AGENT_LOOK[id]?.name || id);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let selected = null, eco = false, eventsOn = true;
  let width = 1, height = 1, zoom = 1, ox = 0, oy = 0;
  let time = 0, last = 0, timer = 0, frame = 0, sparkle = 0;
  function resize() {
    width = host.clientWidth || window.innerWidth; height = host.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, eco ? 1 : 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    zoom = Math.max(width / W, height / H); ox = (width - W * zoom) / 2; oy = (height - H * zoom) / 2;
  }
  function draw(now) {
    if (document.hidden) return;
    const dt = Math.min(.1, last ? (now - last) / 1000 : 0); last = now;
    if (!reduced.matches) time += dt;
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.clearRect(0, 0, width, height); ctx.translate(ox, oy); ctx.scale(zoom, zoom);
    ctx.drawImage(background, 0, 0); drawSky(ctx, time);
    if (eventsOn) for (let i = 0; i < (eco ? 10 : 24); i++) {
      const x = 220 + rand(i) * 1300 + Math.sin(time * .13 + i) * 12;
      const y = 200 + (rand(i + 41) * 670 - time * (1 + i % 3) % 670 + 670) % 670;
      ctx.globalAlpha = .15 + (Math.sin(time * .4 + i) + 1) * .12;
      ellipse(ctx, x, y, 1.1 + sparkle, 1.1 + sparkle, '#fff0b1');
    }
    ctx.globalAlpha = 1; sparkle = Math.max(0, sparkle - dt);
    ctx.drawImage(foreground, 0, 0);
    const glow = ctx.createRadialGradient(920, 560, 170, 810, 480, 1000);
    glow.addColorStop(0, '#ffad3b00'); glow.addColorStop(1, '#28131170'); ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    cats.update(dt); cats.render();
    for (const hook of hooks) hook(now);
    timer = window.setTimeout(() => { frame = requestAnimationFrame(draw); }, 1000 / (reduced.matches ? 4 : eco ? 18 : 30));
  }
  function resume() { clearTimeout(timer); cancelAnimationFrame(frame); last = 0; if (!document.hidden) frame = requestAnimationFrame(draw); }
  window.addEventListener('resize', resize); document.addEventListener('visibilitychange', resume);
  reduced.addEventListener('change', resume); resize(); resume();
  // Keep the shared scene interface; agent meta drives each cat independently.
  return {
    addPlanet(id, look) { agents.add(id); cats.syncAgent(id, {}, look?.name || id); },
    removePlanet(id) { agents.delete(id); cats.removeAgent(id); if (selected === id) selected = null; },
    screen(id) { return cats.screen(id); },
    setStatus(id, state) { cats.syncAgent(id, state, AGENT_LOOK[id]?.name || id); },
    setSelected(id) { selected = agents.has(id) ? id : null; cats.setSelected(selected); },
    setInsets() {}, setTopDown() {},
    setEco(on) { eco = !!on; cats.setEco(eco); resize(); },
    setSkyEvents(on) { eventsOn = !!on; },
    sky() { if (eventsOn) sparkle = 1; },
    fx() {}, workPacket() {}, flashSun() {}, handoff() {},
    onPick(fn) { pickHandler = fn; }, onHover(fn) { hoverHandler = fn; }, onFrame(fn) { hooks.add(fn); },
    get selected() { return selected; }, get quality() { return eco ? 'eco' : 'high'; },
    dispose() {
      clearTimeout(timer); cancelAnimationFrame(frame); window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', resume); reduced.removeEventListener('change', resume);
      cats.dispose(); canvas.remove(); hooks.clear();
    },
  };
}
