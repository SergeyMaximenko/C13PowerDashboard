import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../worker/index.mjs';
import { shouldWriteSnapshot } from '../lib/ingest.mjs';

function fakeKv() {
  const data = new Map();
  let puts = 0;
  return {
    get puts() { return puts; },
    async get(key) { const v = data.get(key); return v ? JSON.parse(v) : null; },
    async put(key, value) { puts++; data.set(key, value); }
  };
}
const NOW = Date.parse('2026-11-13T10:00:00Z');
const env = () => ({ DATA: fakeKv(), INGEST_SECRET: 's3cret' });
const post = (path, body, secret = 's3cret') => new Request('https://x' + path, {
  method: 'POST', headers: { 'X-Ingest-Secret': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const snapshot = { measuredAt: NOW - 60000, requestAt: NOW, gridStatus: 1, gridDate: NOW - 3600000, gridVoltage: 230,
  genStatus: 0, inverterStatus: 1, loadWatts: 800, soc: 80, batteryMode: 'charging', batteryWatts: -300 };

test('ingest: secret, snapshot, hashes, status', async () => {
  const handle = createHandler({ now: () => NOW });
  const e = env();
  assert.equal((await handle(post('/api/ingest', { schemaVersion: 1, snapshot }, 'bad'), e)).status, 401);
  assert.equal((await handle(post('/api/ingest', { schemaVersion: 2, snapshot }), e)).status, 409);

  let res = await handle(post('/api/ingest', { schemaVersion: 1, snapshot, journalHash: 'h1', refuelsHash: 'r1' }), e);
  assert.deepEqual(await res.json(), { ok: true, needJournal: true, needRefuels: true });

  res = await handle(post('/api/ingest/journal', { schemaVersion: 1, hash: 'h1',
    rows: [{ object: 'Світло', at: NOW - 3600000, onOff: 1 }] }), e);
  assert.equal(res.status, 200);
  res = await handle(post('/api/ingest', { schemaVersion: 1, snapshot, journalHash: 'h1', refuelsHash: 'r1' }), e);
  assert.deepEqual(await res.json(), { ok: true, needJournal: false, needRefuels: true });

  const puts = e.DATA.puts;
  await handle(post('/api/ingest', { schemaVersion: 1, snapshot }), e); // unchanged snapshot: no KV write
  assert.equal(e.DATA.puts, puts);

  const status = await (await handle(new Request('https://x/api/status'), e)).json();
  assert.equal(status.grid, 'on');
  assert.equal(status.stale, false);
  assert.equal(status.batteryMode, 'charging');
  assert.equal(status.events.appeared.at, NOW - 3600000);
  assert.equal(status.events.disappeared, null);
});

test('snapshot write limit: status changes at once, other changes at most every 110 s', async () => {
  let clock = NOW;
  const handle = createHandler({ now: () => clock });
  const e = env();
  const send = async patch => handle(post('/api/ingest', { schemaVersion: 1, snapshot: { ...snapshot, ...patch } }), e);
  const stored = async () => (await e.DATA.get('ingest:snapshot')).snapshot;

  await send({ measuredAt: NOW });                       // first run: written
  assert.equal(e.DATA.puts, 1);
  clock = NOW + 60_000;
  await send({ measuredAt: NOW + 60_000, soc: 70 });     // new measurement after 60 s: skipped
  assert.equal(e.DATA.puts, 1);
  assert.equal((await stored()).soc, 80);
  clock = NOW + 90_000;
  await send({ measuredAt: NOW + 90_000, genStatus: 1 }); // status changed: written at once
  assert.equal(e.DATA.puts, 2);
  assert.equal((await stored()).genStatus, 1);
  clock = NOW + 90_000 + 109_000;
  await send({ measuredAt: NOW + 200_000, genStatus: 1, soc: 71 }); // 109 s after the write: still skipped
  assert.equal(e.DATA.puts, 2);
  clock = NOW + 90_000 + 110_000;
  await send({ measuredAt: NOW + 210_000, genStatus: 1, soc: 72 }); // 110 s: written
  assert.equal(e.DATA.puts, 3);
  assert.equal((await stored()).soc, 72);
  await send({ measuredAt: NOW + 210_000, genStatus: 1, soc: 72 }); // same measurement: no write
  assert.equal(e.DATA.puts, 3);
  clock = NOW + 90_000 + 110_000 - 5_000;                 // clock went back: a broken gap must not block writes
  await send({ measuredAt: NOW + 220_000, genStatus: 1 });
  assert.equal(e.DATA.puts, 4);
});

test('shouldWriteSnapshot: unusable stored record is replaced', () => {
  const s = { measuredAt: 2, gridStatus: 1, genStatus: 0, inverterStatus: 1 };
  assert.equal(shouldWriteSnapshot(null, s, 1000), true);
  assert.equal(shouldWriteSnapshot({ snapshot: null }, s, 1000), true);
  assert.equal(shouldWriteSnapshot({ snapshot: { ...s, measuredAt: 1 }, receivedAt: 'x' }, s, 1000), true);
  assert.equal(shouldWriteSnapshot({ snapshot: s, receivedAt: 0 }, s, 1000000), false);
});

test('generator report from the pushed journal and refuels', async () => {
  const handle = createHandler({ now: () => NOW }); // 2026-11-13 12:00 Kyiv
  const e = env();
  const at = text => Date.parse(text);
  const rows = [
    { object: 'Генератор', at: at('2026-11-11T20:00:00Z'), onOff: 1 },          // 22:00 Kyiv, crosses midnight
    { object: 'Генератор', at: at('2026-11-11T23:00:00Z'), onOff: 0, peakW: 8000 }, // 01:00 Kyiv on the 12th
    { object: 'Генератор', at: at('2026-11-12T08:00:00Z'), onOff: 1, test: true }, // test row: ignored
    { object: 'Генератор', at: at('2026-11-13T08:00:00Z'), onOff: 1 }           // 10:00 Kyiv, still on
  ];
  await handle(post('/api/ingest/journal', { schemaVersion: 1, hash: 'j', rows }), e);
  await handle(post('/api/ingest/refuels', { schemaVersion: 1, hash: 'r', rows: [{ at: at('2026-11-13T07:00:00Z'), liters: 20, by: 'Іван' }] }), e);
  await handle(post('/api/ingest', { schemaVersion: 1, snapshot: { ...snapshot, genStatus: 1, genPeak: 5000 } }), e);

  const res = await handle(new Request('https://x/api/generator-report?from=2026-11-11&to=2026-11-13'), e);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.sessions.length, 2);
  assert.equal(data.sessions[0].minutes, 180);
  assert.equal(data.sessions[1].open, true);
  assert.equal(data.sessions[0].peakW, 8000);  // from the stop row
  assert.equal(data.sessions[1].peakW, 5000);  // open run: from the snapshot
  assert.equal(data.days.find(d => d.date === '2026-11-12').peakW, 8000);
  const byDay = Object.fromEntries(data.days.map(d => [d.date, d.minutes]));
  assert.equal(byDay['2026-11-11'], 120);
  assert.equal(byDay['2026-11-12'], 60);
  assert.equal(byDay['2026-11-13'], 120); // 10:00-12:00
  assert.equal(data.refuels[0].by, 'Іван');
  assert.equal(data.days.find(d => d.date === '2026-11-13').refuels.length, 1);
  const live = await (await handle(new Request('https://x/api/status'), e)).json();
  assert.equal(live.generator.startedAt, at('2026-11-13T08:00:00Z')); // open run: no stop
  assert.equal(live.generator.stoppedAt, null);
  const early =await (await handle(new Request('https://x/api/generator-report?from=2026-11-01&to=2026-11-13'), e)).json();
  assert.ok(early.missingDays.every(m => Array.isArray(m.refuels)));
});
