// Pure helpers of the generator page (no DOM): formatting, periods, rows of the table. Covered by tests/generator-page.test.mjs.
export const WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return rest + ' хв';
  return hours + ' год' + (rest ? ' ' + rest + ' хв' : '');
}
const dayWord = n => (n % 10 === 1 && n % 100 !== 11) ? 'день' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? 'дні' : 'днів';
// Calendar time passed (not running time): days and hours ("3 дні 3 год", "1 день 0 год"); no zero days ("5 год"); under an hour: minutes.
export function formatElapsed(minutes) {
  const total = Math.max(0, Math.floor(Number(minutes) || 0));
  if (total < 60) return total + ' хв';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  return (days ? days + ' ' + dayWord(days) + ' ' : '') + hours + ' год';
}
export function formatKw(watts) {
  const value = Number(watts);
  return Number.isFinite(value) && value > 0 ? (value / 1000).toFixed(1).replace('.', ',') + ' кВт' : '—';
}
export function formatLiters(liters) {
  const value = liters === null || liters === undefined || liters === '' ? NaN : Number(liters);
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10).replace('.', ',') + ' л' : '—';
}
export const shortDate = date => date.slice(8, 10) + '.' + date.slice(5, 7);
export const fullDate = date => date.slice(8, 10) + '.' + date.slice(5, 7) + '.' + date.slice(0, 4);
export const timeOf = local => String(local ?? '').slice(11, 16);
export const dateOf = local => String(local ?? '').slice(0, 10);
export const weekday = date => WEEKDAYS[new Date(date + 'T12:00:00Z').getUTCDay()];
export function shiftDay(date, delta) {
  return new Date(Date.parse(date + 'T12:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
}
export function kyivToday(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return p.year + '-' + p.month + '-' + p.day;
}
export function dayRange(from, to, limit = 400) {
  const days = [];
  for (let day = from; day <= to && days.length < limit; day = shiftDay(day, 1)) days.push(day);
  return days;
}
// A real calendar day (2026-02-30 is rejected: it does not survive the round trip).
export const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z'))
  && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;

export function groupSessions(sessions) {
  const groups = new Map();
  for (const session of sessions ?? []) {
    const day = dateOf(session.startLocal);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(session);
  }
  return groups;
}

// One row per calendar day of the period (newest first), also for days without data.
export function buildRows(from, to, data) {
  const byDay = new Map((data?.days ?? []).map(d => [d.date, d]));
  const missing = new Map((data?.missingDays ?? []).map(d => [d.date, d]));
  const sessions = groupSessions(data?.sessions);
  return dayRange(from, to).reverse().map(date => {
    const day = byDay.get(date);
    if (day) return { date, status: 'ok', minutes: day.minutes, starts: day.starts, peakW: day.peakW, refuels: day.refuels ?? [], sessions: sessions.get(date) ?? [] };
    const gap = missing.get(date);
    return { date, status: gap?.reason ?? 'no-data', minutes: 0, starts: 0, peakW: 0, refuels: gap?.refuels ?? [], sessions: [] };
  });
}

export function statusLabel(status) {
  return status === 'no-data' ? 'немає даних' : '';
}
