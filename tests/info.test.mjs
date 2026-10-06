import { test } from 'node:test';
import assert from 'node:assert/strict';

// info.js is browser code; give it just enough of a DOM to be constructed and asked for markup.
const node = () => ({ innerHTML: '', textContent: '', dataset: {}, style: { setProperty() {} }, children: [], addEventListener() {}, querySelector: () => node(), querySelectorAll: () => [], appendChild() {}, classList: { toggle() {} } });
globalThis.requestAnimationFrame = (f) => f();
globalThis.setInterval = () => 0;
globalThis.document = { createElement: node };
const { InfoPanel } = await import('../src/info.js');

function panel() {
  const p = new InfoPanel(node(), { onSelect() {} });
  p.setAgents([{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }], { claude: { hex: '#ffb25a' }, codex: { hex: '#74e6ff' } });
  p.setMeta('claude', { busy: true, stats: { ctx: { used: 80000, window: 1000000 } } });
  return p;
}
const kid = (extra = {}) => ({ id: 'child-1', provider: 'codex', title: 'Review the settings change', busy: true, ctx: { used: 20000, window: 258000 }, cache: 0.5, ...extra });

test('a running subagent gets its own context graph under its main agent', () => {
  const p = panel();
  p.setChildren('claude', [kid()]);
  const html = p.gauges();
  assert.equal((html.match(/class="grow kid/g) || []).length, 1);
  assert.match(html, /Review the settings change/);
  assert.match(html, /20k \/ 258k/);
  assert.match(html, /8%/);
  assert.ok(html.indexOf('class="grow kid') > html.indexOf('Claude'), 'under the main agent');
  assert.ok(html.indexOf('class="grow kid') < html.indexOf('>Codex<'), 'before the next main agent');
});

test('the subagent graph builds a history as usage changes and disappears when it stops', () => {
  const p = panel();
  p.setChildren('claude', [kid()]);
  assert.doesNotMatch(p.kidGauges('claude'), /<svg/); // one point is not a line yet
  p.setChildren('claude', [kid({ ctx: { used: 40000, window: 258000 } })]);
  p.setChildren('claude', [kid({ ctx: { used: 40000, window: 258000 } })]); // unchanged: no duplicate point
  p.setChildren('claude', [kid({ ctx: { used: 90000, window: 258000 } })]);
  assert.equal(p.hist['kid:child-1'].length, 3);
  const html = p.kidGauges('claude');
  assert.match(html, /<svg class="hs"/);
  assert.match(html, /stroke="#74e6ff"/); // drawn in the subagent's own colour

  p.setChildren('claude', [kid({ busy: false })]);
  assert.equal(p.kidGauges('claude'), '');
  p.setChildren('claude', []);
  assert.equal(p.hist['kid:child-1'], undefined);
});

test('a subagent that has not reported usage yet shows as starting, not as an error', () => {
  const p = panel();
  p.setChildren('codex', [kid({ ctx: null })]);
  assert.match(p.kidGauges('codex'), /starting…/);
});
