import { parseTime } from './domain.mjs';

// Kyiv date helpers shared by the Worker.
const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
export function localText(ms) {
  const p = Object.fromEntries(localFormatter.formatToParts(ms).map(x => [x.type, x.value]));
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
}
export function shiftDay(day, delta) {
  return new Date(Date.parse(day + 'T12:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
}
export function dayStart(day) { return parseTime(day + ' 00:00:00'); }
