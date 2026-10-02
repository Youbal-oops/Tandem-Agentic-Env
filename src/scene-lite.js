// Text-only stand-in for scene.js: the same surface main.js calls, all no-ops, so three.js, WebGL and
// the animation loop are never loaded. Selected by ?lite or the Lite button (saved in localStorage).
const NOOP = () => {};
const HIDDEN = { x: 0, y: 0, r: 0, visible: false };
export function createScene() {
  return new Proxy({}, { get: (_, name) => (name === 'screen' ? () => HIDDEN : NOOP) });
}
