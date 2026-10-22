const test = require('node:test'); const assert = require('node:assert');
const { clamp } = require('../keeper/keeper.js');
test('keeper clamps each move to the per-tick bps limit', () => {
  assert.equal(clamp(0, 150, 100), 150);
  assert.equal(clamp(100, 150, 100), 101);
  assert.equal(clamp(100, 50, 100), 99);
  assert.equal(clamp(100, 100.5, 100), 100.5);
});
