import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function inverterState(');
const end = source.indexOf('function render(', start);
const state = vm.runInNewContext(source.slice(start, end) + '; inverterState;');
test('inverter operation: all five states, charging with load, missing and contradictory readings', () => {
  const data = { grid: 'off', output: 'on', loadWatts: 0, batteryMode: 'idle' };
  assert.equal(state(data, false), 'standby');
  assert.equal(state({ ...data, loadWatts: 35 }, false), 'supplying');
  assert.equal(state({ ...data, batteryMode: 'charging' }, false), 'charging');
  assert.equal(state({ ...data, batteryMode: 'charging', loadWatts: 1200 }, false), 'supplying');
  assert.equal(state({ ...data, output: 'off' }, false), 'off');
  assert.equal(state({ ...data, output: 'off', batteryMode: 'charging' }, false), 'charging');
  assert.equal(state(data, true), 'unknown');
  assert.equal(state({ ...data, loadWatts: null }, false), 'unknown');
  assert.equal(state({ ...data, batteryMode: 'unknown' }, false), 'unknown');
  assert.equal(state({ ...data, output: 'unstable' }, false), 'unknown');
  assert.equal(state({ ...data, output: 'off', loadWatts: 100 }, false), 'unknown');
});

test('ATS mains priority: 114 W while charging must not mean building supplied by inverter', () => {
  const data = { grid: 'on', output: 'on', loadWatts: 114, batteryMode: 'charging' };
  assert.equal(state(data, false), 'charging');
  assert.equal(state({ ...data, loadWatts: 12000 }, false), 'charging');
  assert.equal(state({ ...data, batteryMode: 'idle' }, false), 'standby');
  assert.equal(state({ ...data, batteryMode: 'unknown' }, false), 'unknown');
  assert.equal(state({ ...data, batteryMode: 'discharging' }, false), 'standby');
  assert.equal(state({ ...data, grid: 'off', batteryMode: 'discharging' }, false), 'supplying');
  assert.equal(state({ ...data, grid: 'unknown' }, false), 'unknown');
  assert.equal(state({ ...data, grid: 'unstable' }, false), 'unknown');
  assert.equal(state(data, true), 'unknown');
});
