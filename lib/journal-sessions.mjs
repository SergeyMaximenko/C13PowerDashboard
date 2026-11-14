import { localText, dayStart, shiftDay } from './generator.mjs';

// Generator runs from the journal pushed by the C# application (rows with object "Генератор", onOff 1 = started, 0 = stopped).
// Test rows (test: true) are ignored. `snapshot.genStatus` decides whether the last start is still running.
export function sessionsFromJournal(rows, { now, genStatus = null, genPeak = null }) {
  const events = rows.filter(r => r.object === 'Генератор' && !r.test).sort((a, b) => a.at - b.at);
  const sessions = [];
  let start = null;
  const push = (from, to, open, peakW) => sessions.push({
    start: from, end: open ? null : to, minutes: Math.max(0, Math.round((to - from) / 60000)), peakW: peakW ?? 0, open,
    startLocal: localText(from), endLocal: open ? null : localText(to)
  });
  for (const event of events) {
    if (event.onOff === 1) { if (start === null) start = event.at; continue; }
    if (start === null && event.hoursGenOn > 0) start = event.at - Math.round(event.hoursGenOn * 3600000); // start row is missing
    if (start !== null) { push(start, event.at, false, event.peakW); start = null; }
  }
  // The last start without a stop: still running, unless the current state says the generator is off.
  if (start !== null && genStatus !== 0) push(start, now, true, genPeak);
  return sessions;
}

// Minutes of the sessions that fall inside one Kyiv calendar day; `starts` = runs that started that day.
export function summarizeDayFromSessions(date, sessions, now) {
  const from = dayStart(date);
  const to = dayStart(shiftDay(date, 1));
  let minutes = 0;
  let starts = 0;
  let peakW = 0;
  for (const s of sessions) {
    const end = s.end ?? now;
    const overlap = Math.min(end, to) - Math.max(s.start, from);
    if (overlap > 0) { minutes += Math.round(overlap / 60000); peakW = Math.max(peakW, s.peakW ?? 0); }
    if (s.start >= from && s.start < to) starts++;
  }
  return { date, minutes, starts, peakW };
}
