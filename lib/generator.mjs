import { points, parseTime, generatorInfo } from './domain.mjs';

// Measurements that describe the generator on the inverter's GEN input (real Deye keys).
// Deye rejects long lists ("list too long", code 2101007), so only 4 keys are requested (the grid request uses 4 as well).
export const GENERATOR_POINTS = ['GenVoltageL1', 'GenVoltageL2', 'GenVoltageL3', 'TotalGeneratorPower'];
// Two history points are normally ~5 minutes apart. A longer silence means the data is missing: a run is not stretched over it.
export const GAP_MS = 20 * 60_000;

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

// Rows of device/history -> [{ time, on, powerW }] for one calendar day (Kyiv). Rows without generator data are skipped.
export function samplesFromRows(rows, day) {
  const start = dayStart(day);
  const end = dayStart(shiftDay(day, 1));
  const samples = [];
  for (const row of rows) {
    const time = parseTime(row.collectionTime ?? row.time, day);
    if (time === null || time < start || time >= end) continue;
    const info = generatorInfo(points(row.itemList));
    if (info.state === 'unknown') continue;
    samples.push({ time, on: info.state === 'on', powerW: info.powerW });
  }
  return samples;
}

// Joins consecutive "on" samples into runs. A run ends at the first "off" sample (the stop happened between the two),
// or at its last "on" sample when the data has a gap. Only the newest run can still be open.
export function buildSessions(samples, { now = Date.now(), gapMs = GAP_MS, allowOpen = false } = {}) {
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const sessions = [];
  let current = null;
  let previous = null;
  // cut: the run ended because the data ended (gap or end of the day), not because an "off" sample was seen.
  const finish = (end, open = false, cut = false) => {
    sessions.push({
      start: current.start, end: open ? null : end,
      minutes: Math.round((end - current.start) / 60000),
      peakW: current.peakW, open, cut,
      startLocal: localText(current.start), endLocal: open ? null : localText(end)
    });
    current = null;
  };
  for (const sample of sorted) {
    if (current && sample.time - previous.time > gapMs) finish(current.lastOn, false, true);
    if (sample.on) {
      if (!current) current = { start: sample.time, peakW: 0, lastOn: sample.time };
      current.lastOn = sample.time;
      current.peakW = Math.max(current.peakW, sample.powerW ?? 0);
    } else if (current) finish(sample.time);
    previous = sample;
  }
  if (current) {
    const open = allowOpen && now - current.lastOn <= gapMs;
    finish(current.lastOn, open, true);
  }
  return sessions;
}

// A run that goes through midnight is calculated per day, so it arrives as two pieces: the first one is cut at the end
// of the day, the second one starts right after midnight. Joins such pieces (the 5-minute gap between them counts).
export function mergeAcrossMidnight(sessions, gapMs = GAP_MS) {
  const merged = [];
  for (const session of [...sessions].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && previous.cut && !previous.open && session.start - previous.end <= gapMs
      && previous.endLocal.slice(0, 10) !== session.startLocal.slice(0, 10)) {
      merged[merged.length - 1] = {
        ...previous, end: session.end, endLocal: session.endLocal, open: session.open, cut: session.cut,
        minutes: previous.minutes + Math.round((session.start - previous.end) / 60000) + session.minutes,
        peakW: Math.max(previous.peakW, session.peakW)
      };
    } else merged.push(session);
  }
  return merged;
}

// Only the part of the runs after a moment (e.g. after refuelling). A run that started earlier is cut at that moment.
export function clipSessions(sessions, from) {
  const result = [];
  for (const session of sessions) {
    if (session.end !== null && session.end <= from) continue;
    if (session.start >= from) { result.push(session); continue; }
    result.push({
      ...session, start: from, startLocal: localText(from),
      minutes: Math.max(0, session.minutes - Math.round((from - session.start) / 60000))
    });
  }
  return result;
}

export function summarizeDay(date, sessions) {
  return {
    date,
    minutes: sessions.reduce((sum, s) => sum + s.minutes, 0),
    starts: sessions.length,
    peakW: sessions.reduce((max, s) => Math.max(max, s.peakW), 0),
    sessions
  };
}
