import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../worker/index.mjs';

const env = { DEYE_APP_ID: 'a', DEYE_APP_SECRET: 'SECRET-VALUE', DEYE_LOGIN: 'l', DEYE_PASSWORD: 'PASSWORD-VALUE', DEYE_STATION_ID: '1', CACHE_SECONDS: '30' };
const sample = { station: { name: 'Чавдар 13' }, collectedAt: 1000, grid: 'off', output: 'on', soc: 72, batteryMode: 'discharging', diagnostics: {}, token: 'LEAK' };
const get = (handle, path = '/api/status', e = env) => handle(new Request('https://w.example' + path), e);

test('worker caches the answer and refreshes after the cache time', async () => {
  let calls = 0, clock = 0;
  const handle = createHandler({ now: () => clock, clientFactory: () => ({ dashboard: async () => { calls++; return { ...sample, collectedAt: 1000 + calls }; } }) });
  const first = await get(handle);
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  clock = 29000;
  const second = await get(handle);
  assert.equal(second.headers.get('X-Cache'), 'HIT');
  assert.equal(calls, 1);
  clock = 31000;
  const third = await get(handle);
  assert.equal(third.headers.get('X-Cache'), 'MISS');
  assert.equal(calls, 2);
  assert.equal((await third.json()).collectedAt, 1002);
});

test('worker publishes only allowlisted fields', async () => {
  const handle = createHandler({ clientFactory: () => ({ dashboard: async () => sample }) });
  const text = await (await get(handle)).text();
  assert.ok(!text.includes('LEAK') && !text.includes('SECRET-VALUE') && !text.includes('PASSWORD-VALUE'));
  assert.equal(JSON.parse(text).soc, 72);
});

test('worker serves the last good answer when Deye fails', async () => {
  let fail = false, clock = 0;
  const handle = createHandler({ now: () => clock, clientFactory: () => ({ dashboard: async () => { if (fail) throw new Error('password PASSWORD-VALUE'); return sample; } }) });
  await get(handle);
  fail = true; clock = 60000;
  const response = await get(handle);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Cache'), 'STALE');
});

test('worker hides upstream error text and reports missing configuration', async () => {
  const broken = createHandler({ clientFactory: () => ({ dashboard: async () => { throw new Error('secret PASSWORD-VALUE'); } }) });
  const failed = await get(broken);
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes('PASSWORD-VALUE'));
  const unconfigured = await get(createHandler(), '/api/status', {});
  assert.equal(unconfigured.status, 500);
});

test('worker opens another station only from the allowed list; default stays the main station', async () => {
  const seen = [];
  const handle = createHandler({ clientFactory: settings => ({ dashboard: async () => { seen.push(settings.stationId); return { ...sample, station: { name: settings.stationName } }; } }) });
  const withList = { ...env, ALLOWED_STATION_IDS: '2:Друга станція' };
  assert.equal((await (await get(handle, '/api/status', withList)).json()).station.name, 'Чавдар 13');
  assert.equal((await (await get(handle, '/api/status?station=2', withList)).json()).station.name, 'Друга станція');
  assert.equal((await get(handle, '/api/status?station=999', withList)).status, 403);
  assert.deepEqual(seen, ['1', '2']);
  assert.equal((await get(handle, '/api/status?station=2', env)).status, 403);
});

test('worker allows only GET and sends CORS headers', async () => {
  const handle = createHandler({ clientFactory: () => ({ dashboard: async () => sample }) });
  assert.equal((await handle(new Request('https://w.example/api/status', { method: 'POST' }), env)).status, 405);
  assert.equal((await get(handle)).headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await get(handle, '/api/status', { ...env, ALLOWED_ORIGIN: 'https://x.example' })).headers.get('Access-Control-Allow-Origin'), 'https://x.example');
  assert.equal((await get(handle, '/other')).status, 404);
});
