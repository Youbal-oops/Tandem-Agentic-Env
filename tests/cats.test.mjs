import test from 'node:test';
import assert from 'node:assert/strict';
import { catActivity, moveCat } from '../src/cat-behavior.js';

test('cats prioritize approval and tool activity over the busy/thinking flags', () => {
  assert.equal(catActivity({ busy: true, thinking: true, moons: ['edit'] }), 'kneading');
  assert.equal(catActivity({ busy: true, moons: ['read'] }), 'watching');
  assert.equal(catActivity({ thinking: true, moons: ['shell'] }), 'playing');
  assert.equal(catActivity({ awaiting: 1, moons: ['edit'] }), 'waiting');
  assert.equal(catActivity({ busy: true }), 'thinking');
  assert.equal(catActivity({ status: 'running' }), 'thinking');
  assert.equal(catActivity({ status: 'completed' }), 'sleeping');
  assert.equal(catActivity({ status: 'failed' }), 'startled');
});

test('walking converges on the nest without overshooting at different frame rates', () => {
  for (const fps of [12, 18, 30, 60]) {
    const cat = { x: 0, direction: -1 };
    for (let frame = 0; frame < fps * 5; frame++) moveCat(cat, 43, 1 / fps);
    assert.ok(Math.abs(cat.x - 43) <= 1.5);
    assert.ok(cat.x <= 43);
    assert.equal(cat.walking, false);
    assert.equal(cat.direction, 1);
    for (let frame = 0; frame < fps * 5; frame++) moveCat(cat, -20, 1 / fps);
    assert.ok(Math.abs(cat.x + 20) <= 1.5);
    assert.equal(cat.walking, false);
    assert.equal(cat.direction, -1);
  }
});
