import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseRefuels, parseRefuelTime } from '../lib/refuels.mjs';
import { buildSessions, clipSessions } from '../lib/generator.mjs';
import { createHandler } from '../worker/index.mjs';

const at = text => Date.parse(text + '+02:00');
const HEADER = 'Дата події,Дата заправки,Літри,Користувач ID,Користувач Код,Користувач Ім\'я,Платформа,Режим тесту,Відправлено в TG,Використано по плановому розрахунку,Не враховувати винагороду';
const CSV = [
  HEADER,
  '2026-02-18 9:02:16,2026-02-18 8:56,70,190735561,mzheliez,Maksym,android,,так,"105,731",',
  '2026-03-20 10:03:02,2026-03-01 10:00,91,218571065,SergiiNM,Sergii,ios,так,так,"111,317",',
  '2026-04-09 22:06:52,2026-04-09 22:01,100,136077800,BogdanKiev,Bogdan,ios,,так,"109,713",так',
  '2026-11-06 0:21:10,2026-11-05 19:43,110,198653880,reindsher,Ваня,android,,так,"78,098",',
  '2026-11-06 21:10:30,2026-11-06 21:10,"110,5",198653880,reindsher,Ваня,android,,так,0,',
  ',,,,,,,,,,'
].join('\r\n');

test('csv: quotes, commas and line breaks inside quotes, empty lines', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""x"""\n\n1,2,3'), [['a', 'b,c', 'd "x"'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('﻿a,"line1\nline2"\r\nb,c'), [['a', 'line1\nline2'], ['b', 'c']]);
});

test('refuel time: one-digit hour, seconds optional, Kyiv time, dd.mm.yyyy', () => {
  assert.equal(parseRefuelTime('2026-02-18 8:56'), at('2026-02-18T08:56:00'));
  assert.equal(parseRefuelTime('2026-11-06 21:10:30'), at('2026-11-06T21:10:30'));
  assert.equal(parseRefuelTime('06.11.2026 21:10'), at('2026-11-06T21:10:00'));
  assert.equal(parseRefuelTime('сьогодні'), null);
  assert.equal(parseRefuelTime(''), null);
});

test('refuels: takes "Дата заправки", skips tests and excluded rows, decimal comma', () => {
  const refuels = parseRefuels(CSV);
  assert.deepEqual(refuels.map(r => r.atLocal), ['2026-02-18 08:56', '2026-11-05 19:43', '2026-11-06 21:10']);
  assert.deepEqual(refuels.map(r => r.liters), [70, 110, 110.5]);
  assert.deepEqual(refuels.map(r => r.by), ['Maksym', 'Ваня', 'Ваня']);
  // Name missing -> login; decorative letters -> plain; the Telegram ID never appears.
  const people = parseRefuels(HEADER + '\n,2026-11-01 10:00,50,111,mzheliez,,android,,,,\n,2026-11-02 10:00,50,222,,"𝕰𝖛𝖌𝖊𝖓𝖎𝖞",ios,,,,\n,2026-11-03 10:00,50,333,,,ios,,,,\n');
  assert.deepEqual(people.map(r => r.by), ['mzheliez', 'Evgeniy', null]);
  assert.ok(!JSON.stringify(refuels).includes('190735561'));
  assert.throws(() => parseRefuels('a,b\n1,2'), /Дата заправки.*Перший рядок: a \| b/);
  // Header with a non-breaking space / line break inside, and extra rows above it.
  const messy = 'Журнал\n\n"Дата заправки\n(час)",Літри\n2026-11-06 21:10,90\n';
  assert.deepEqual(parseRefuels(messy).map(r => [r.atLocal, r.liters]), [['2026-11-06 21:10', 90]]);
});

test('clip: runs before the moment are dropped, a run through it is cut', () => {
  const on = (time, powerW = 1) => ({ time: at(time), on: true, powerW });
  const off = time => ({ time: at(time), on: false, powerW: 0 });
  const sessions = buildSessions([on('2026-11-06T10:00:00'), off('2026-11-06T10:10:00'),
    on('2026-11-06T21:00:00'), on('2026-11-06T21:10:00'), on('2026-11-06T21:20:00'), off('2026-11-06T21:30:00')]);
  const clipped = clipSessions(sessions, at('2026-11-06T21:10:00'));
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].startLocal, '2026-11-06 21:10');
  assert.equal(clipped[0].minutes, 20);
});

const env = { DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_LOGIN: 'l', DEYE_PASSWORD: 'p', DEYE_STATION_ID: '1' };
const sample = (date) => [
  { time: at(date + 'T10:00:00'), on: true, powerW: 5000 }, { time: at(date + 'T10:05:00'), on: true, powerW: 5000 },
  { time: at(date + 'T10:10:00'), on: false, powerW: 0 }];

test('/api/generator-report: refuel marks on days, runtime since the last refuel, no link leaked', async () => {
  const link = 'https://docs.google.com/spreadsheets/d/e/SECRET-LINK/pub?output=csv';
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async url => { fetches++; assert.equal(String(url), link); return new Response(CSV); };
  try {
    const clock = at('2026-11-09T12:00:00');
    const handle = createHandler({ clientFactory: () => ({ generatorSamples: async (station, date) => sample(date) }), now: () => clock });
    const get = async query => { const r = await handle(new Request('https://x.test/api/generator-report' + query), { ...env, REFUELS_CSV_URL: link }); return { status: r.status, text: await r.text() }; };

    const first = await get('?from=2026-11-05&to=2026-11-09');
    assert.equal(first.status, 200);
    assert.ok(!first.text.includes('SECRET-LINK'));
    const body = JSON.parse(first.text);
    assert.equal(body.refuelsConfigured, true);
    assert.deepEqual(body.refuels.map(r => r.atLocal), ['2026-11-05 19:43', '2026-11-06 21:10']);
    const nov6 = body.days.find(d => d.date === '2026-11-06');
    assert.equal(nov6.refuels.length, 1);
    assert.equal(nov6.refuels[0].liters, 110.5);
    assert.deepEqual(body.days.find(d => d.date === '2026-11-07').refuels, []);
    // After the refuel at 21:10 on 6 Nov: one run on 7, 8 and 9 Nov (10 minutes each).
    assert.equal(body.since.refuel.atLocal, '2026-11-06 21:10');
    assert.equal(body.since.minutes, 30);
    assert.equal(body.since.starts, 3);
    assert.equal(body.since.complete, true);

    await get('?from=2026-11-07&to=2026-11-09');
    assert.equal(fetches, 1, 'the table is cached');
  } finally { globalThis.fetch = original; }
});

test('/api/generator-report: no table configured, table unavailable, days still loading', async () => {
  const clock = at('2026-11-09T12:00:00');
  const handle = createHandler({ clientFactory: () => ({ generatorSamples: async (station, date) => sample(date) }), now: () => clock });
  const none = await (await handle(new Request('https://x.test/api/generator-report?from=2026-11-08&to=2026-11-09'), env)).json();
  assert.equal(none.refuelsConfigured, false);
  assert.equal(none.since, null);
  assert.equal(none.days.length, 2);

  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('boom https://docs.google.com/SECRET'); };
  try {
    const failing = createHandler({ clientFactory: () => ({ generatorSamples: async (station, date) => sample(date) }), now: () => clock });
    const response = await failing(new Request('https://x.test/api/generator-report?from=2026-11-08&to=2026-11-09'), { ...env, REFUELS_CSV_URL: 'https://docs.google.com/SECRET' });
    const text = await response.text();
    assert.ok(!text.includes('SECRET'));
    assert.match(JSON.parse(text).refuelsError, /таблицю заправок/);
  } finally { globalThis.fetch = original; }

  // 20 days since the last refuel: the first request loads at most 7 new days, the rest is "pending" (since.complete = false).
  globalThis.fetch = async () => new Response(HEADER + '\n2026-10-20 8:00:00,2026-10-20 8:00,100,1,a,b,c,,так,1,\n');
  try {
    const slow = createHandler({ clientFactory: () => ({ generatorSamples: async (station, date) => sample(date) }), now: () => clock });
    const run = async () => (await (await slow(new Request('https://x.test/api/generator-report?from=2026-11-08&to=2026-11-09'), { ...env, REFUELS_CSV_URL: 'https://example.test/x.csv' })).json()).since;
    let since = await run();
    assert.equal(since.complete, false);
    for (let i = 0; i < 4 && !since.complete; i++) since = await run();
    assert.equal(since.complete, true);
    assert.equal(since.starts, 21); // 20 Oct .. 9 Nov, one run a day (the first one starts after 8:00 so it is whole)
  } finally { globalThis.fetch = original; }
});
