import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessions, summarizeDay, samplesFromRows, shiftDay, mergeAcrossMidnight } from '../lib/generator.mjs';
import { createHandler } from '../worker/index.mjs';

const at = text => Date.parse(text + '+02:00');
const on = (time, powerW = 20000) => ({ time: at(time), on: true, powerW });
const off = time => ({ time: at(time), on: false, powerW: 0 });

test('sessions: start, stop at first off sample, several runs', () => {
  const sessions = buildSessions([off('2026-11-04T13:55:00'), on('2026-11-04T14:00:00', 5000), on('2026-11-04T14:05:00', 47000),
    on('2026-11-04T14:10:00'), off('2026-11-04T14:15:00'), off('2026-11-04T14:20:00'),
    on('2026-11-04T18:00:00'), off('2026-11-04T18:05:00')]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].startLocal, '2026-11-04 14:00');
  assert.equal(sessions[0].endLocal, '2026-11-04 14:15');
  assert.equal(sessions[0].minutes, 15);
  assert.equal(sessions[0].peakW, 47000);
  assert.equal(sessions[1].minutes, 5);
  assert.deepEqual(summarizeDay('2026-11-04', sessions).minutes, 20);
  assert.equal(summarizeDay('2026-11-04', sessions).starts, 2);
});

test('sessions: a data gap ends the run, open run only for today', () => {
  const gap = buildSessions([on('2026-11-04T10:00:00'), on('2026-11-04T10:05:00'), on('2026-11-04T12:00:00'), off('2026-11-04T12:05:00')]);
  assert.equal(gap.length, 2);
  assert.equal(gap[0].endLocal, '2026-11-04 10:05');
  const samples = [off('2026-11-04T09:55:00'), on('2026-11-04T10:00:00'), on('2026-11-04T10:05:00')];
  const now = at('2026-11-04T10:07:00');
  const open = buildSessions(samples, { now, allowOpen: true });
  assert.equal(open[0].open, true); assert.equal(open[0].end, null); assert.equal(open[0].minutes, 5);
  assert.equal(buildSessions(samples, { now, allowOpen: false })[0].open, false);
  assert.equal(buildSessions(samples, { now: at('2026-11-04T11:00:00'), allowOpen: true })[0].open, false);
  assert.deepEqual(buildSessions([]), []);
});

test('a run through midnight is one run; a stop and a new start at midnight are two', () => {
  const day1 = buildSessions([on('2026-11-08T23:30:00'), on('2026-11-08T23:40:00'), on('2026-11-08T23:50:00'), on('2026-11-08T23:55:00')]);
  const day2 = buildSessions([on('2026-11-09T00:00:00'), on('2026-11-09T00:05:00'), off('2026-11-09T00:10:00')]);
  const one = mergeAcrossMidnight([...day1, ...day2]);
  assert.equal(one.length, 1);
  assert.equal(one[0].startLocal, '2026-11-08 23:30');
  assert.equal(one[0].endLocal, '2026-11-09 00:10');
  assert.equal(one[0].minutes, 40);
  const stopped = buildSessions([on('2026-11-08T23:30:00'), off('2026-11-08T23:55:00')]);
  assert.equal(mergeAcrossMidnight([...stopped, ...day2]).length, 2);
  const farApart = buildSessions([on('2026-11-09T06:00:00'), off('2026-11-09T06:05:00')]);
  assert.equal(mergeAcrossMidnight([...day1, ...farApart]).length, 2);
});

test('rows: generator keys only, day bounds in Kyiv time, rows without generator data skipped', () => {
  const row = (time, items) => ({ collectionTime: String(at(time) / 1000), itemList: Object.entries(items).map(([key, value]) => ({ key, value })) });
  const samples = samplesFromRows([
    row('2026-11-04T10:00:00', { GenVoltageL1: 231, TotalGeneratorPower: 4000 }),
    row('2026-11-04T10:05:00', { GenVoltageL1: 0, TotalGeneratorPower: 0 }),
    row('2026-11-04T10:10:00', { SOC: 50 }),
    row('2026-11-03T23:55:00', { GenVoltageL1: 231 }),
    row('2026-11-05T00:00:00', { GenVoltageL1: 231 })
  ], '2026-11-04');
  assert.deepEqual(samples.map(s => s.on), [true, false]);
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
});

const env = { DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_LOGIN: 'l', DEYE_PASSWORD: 'p', DEYE_STATION_ID: '1' };
const request = query => new Request('https://x.test/api/generator' + query);

test('/api/generator: validates period, caches finished days (memory and KV), today separately, limits Deye calls', async () => {
  let clock = at('2026-11-09T12:00:00');
  const calls = [];
  const factory = () => ({ generatorSamples: async (station, date) => {
    calls.push(date);
    if (date === '2026-11-02') return [];
    return [on(date + 'T10:00:00'), on(date + 'T10:05:00'), off(date + 'T10:10:00')];
  } });
  const store = new Map();
  const kv = { get: async key => store.has(key) ? JSON.parse(store.get(key)) : null, put: async (key, value) => { store.set(key, value); } };
  const handle = createHandler({ clientFactory: factory, now: () => clock });
  const run = async query => { const r = await handle(request(query), { ...env, GEN: kv }); return { status: r.status, body: await r.json() }; };

  assert.equal((await run('?from=2026-11-05&to=2026-11-04')).status, 400);
  assert.equal((await run('?from=bad&to=2026-11-04')).status, 400);
  assert.equal((await run('?from=2026-02-30&to=2026-03-02')).status, 400);
  assert.equal((await run('?from=2026-11-01&to=2026-11-10')).status, 400);
  assert.equal((await run('?from=2026-09-01&to=2026-11-09')).status, 400);

  const first = await run('?from=2026-11-02&to=2026-11-09');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.missingDays.map(d => d.date + ':' + d.reason), ['2026-11-02:no-data']);
  assert.equal(first.body.days.length, 7);
  assert.equal(first.body.totalMinutes, 7 * 10);
  assert.equal(first.body.sessions.length, 7);
  assert.equal(first.body.sessions.at(-1).open, false); // the "off" sample closes today's run
  assert.ok(store.has('gen:v2:1:2026-11-08'));
  assert.ok(!store.has('gen:v2:1:2026-11-09'));

  // Second request: finished days come from memory, no calls to Deye except today (cached for 10 minutes).
  calls.length = 0;
  await run('?from=2026-11-03&to=2026-11-09');
  assert.deepEqual(calls, []);
  clock += 11 * 60000;
  await run('?from=2026-11-03&to=2026-11-09');
  assert.deepEqual(calls, ['2026-11-09']);

  // New handler (cold isolate): finished days are restored from KV.
  const cold = createHandler({ clientFactory: factory, now: () => clock });
  calls.length = 0;
  const restored = await (await cold(request('?from=2026-11-03&to=2026-11-08'), { ...env, GEN: kv })).json();
  assert.equal(restored.days.length, 6);
  assert.deepEqual(calls, []);
});

test('/api/generator: Deye calls per request are limited, the rest is pending; errors do not break the answer', async () => {
  const calls = [];
  const factory = () => ({ generatorSamples: async (station, date) => {
    calls.push(date);
    if (date === '2026-11-03') throw new Error('Deye down');
    return [on(date + 'T10:00:00'), off(date + 'T10:05:00')];
  } });
  const handle = createHandler({ clientFactory: factory, now: () => at('2026-11-09T12:00:00') });
  const body = await (await handle(request('?from=2026-10-10&to=2026-11-08'), env)).json();
  assert.equal(calls.length, 7);
  const reasons = body.missingDays.map(d => d.reason);
  assert.equal(reasons.filter(r => r === 'pending').length, 30 - 7);
  assert.equal((await (await handle(request('?from=2026-11-03&to=2026-11-03'), env)).json()).missingDays[0].reason, 'error');
});
