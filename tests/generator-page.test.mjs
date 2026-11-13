import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatElapsed, formatKw, formatLiters, shortDate, fullDate, timeOf, weekday, shiftDay, kyivToday, dayRange, isDay,
  groupSessions, buildRows, needsRetry, statusLabel } from '../public/generator-lib.js';

test('formatting: duration, kW, liters, dates', () => {
  assert.equal(formatDuration(0), '0 хв');
  assert.equal(formatDuration(45), '45 хв');
  assert.equal(formatDuration(60), '1 год');
  assert.equal(formatDuration(980), '16 год 20 хв');
  assert.equal(formatDuration(null), '0 хв');
  assert.deepEqual([0, 25, 60, 312, 1440, 4630, 2 * 1440 + 60, 5 * 1440, 21 * 1440, 12 * 1440].map(formatElapsed),
    ['0 хв', '25 хв', '1 год', '5 год', '1 день 0 год', '3 дні 5 год', '2 дні 1 год', '5 днів 0 год', '21 день 0 год', '12 днів 0 год']);
  assert.equal(formatElapsed(-5), '0 хв');
  assert.equal(formatKw(51298), '51,3 кВт');
  assert.equal(formatKw(0), '—');
  assert.equal(formatLiters(110), '110 л');
  assert.equal(formatLiters(110.5), '110,5 л');
  assert.equal(formatLiters(null), '—');
  assert.equal(shortDate('2026-11-09'), '09.11');
  assert.equal(fullDate('2026-11-09'), '09.11.2026');
  assert.equal(timeOf('2026-11-06 21:10'), '21:10');
  assert.equal(weekday('2026-11-09'), 'пн');
});

test('days: shift over a month, range, validation, Kyiv today', () => {
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(dayRange('2026-11-08', '2026-11-10'), ['2026-11-08', '2026-11-09', '2026-11-10']);
  assert.equal(isDay('2026-02-30'), false);
  assert.equal(isDay('2026-11-09'), true);
  assert.equal(isDay('09.11.2026'), false);
  // 23:30 UTC on 8 Nov is already 9 Nov in Kyiv (UTC+2).
  assert.equal(kyivToday(Date.parse('2026-11-08T23:30:00Z')), '2026-11-09');
});

const data = {
  days: [
    { date: '2026-11-06', minutes: 344, starts: 3, peakW: 51562, refuels: [{ atLocal: '2026-11-06 21:10', liters: 110 }] },
    { date: '2026-11-07', minutes: 0, starts: 0, peakW: 0, refuels: [] }
  ],
  sessions: [
    { startLocal: '2026-11-06 14:36', endLocal: '2026-11-06 16:43', minutes: 128, peakW: 51562, open: false },
    { startLocal: '2026-11-06 23:32', endLocal: '2026-11-07 00:08', minutes: 36, peakW: 49653, open: false }
  ],
  missingDays: [{ date: '2026-11-05', reason: 'no-data' }, { date: '2026-11-08', reason: 'pending' }]
};

test('rows: one per day, newest first, sessions grouped by the day they start, missing days marked', () => {
  const rows = buildRows('2026-11-05', '2026-11-08', data);
  assert.deepEqual(rows.map(r => r.date + ':' + r.status), ['2026-11-08:pending', '2026-11-07:ok', '2026-11-06:ok', '2026-11-05:no-data']);
  const nov6 = rows.find(r => r.date === '2026-11-06');
  assert.equal(nov6.sessions.length, 2); // the run through midnight stays on the day it started
  assert.equal(nov6.refuels[0].liters, 110);
  assert.equal(rows.find(r => r.date === '2026-11-07').sessions.length, 0);
  assert.equal(groupSessions(undefined).size, 0);
  assert.equal(statusLabel('pending'), 'завантажується…');
});

test('retry: only while days are pending or the sum since the refuel is incomplete', () => {
  assert.equal(needsRetry(data), true);
  assert.equal(needsRetry({ missingDays: [{ date: 'x', reason: 'no-data' }], since: { complete: true } }), false);
  assert.equal(needsRetry({ missingDays: [], since: { complete: false } }), true);
  assert.equal(needsRetry({ missingDays: [], since: null }), false);
  assert.equal(needsRetry(null), false);
});
