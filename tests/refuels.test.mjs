import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseRefuels, parseRefuelTime } from '../lib/refuels.mjs';

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
