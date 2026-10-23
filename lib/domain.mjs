export const ZONE = 'Europe/Kyiv';
export const STALE_MS = 60 * 60_000;
export function number(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function parts(ms) {
  return Object.fromEntries(partsFormatter.formatToParts(ms).map(p => [p.type, p.value]));
}
export function dayAt(ms) {
  const p = parts(ms);
  return p.year + '-' + p.month + '-' + p.day;
}
export function previousDay(day) {
  return new Date(Date.parse(day + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
}
export function parseTime(value, day) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    const ms = n > 1e12 ? n : n * 1000;
    return ms >= 1e12 && ms <= 4102444800000 ? ms : null;
  }
  if (/(Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  const full = /^\d{2}:\d{2}(:\d{2})?$/.test(raw) && day ? day + ' ' + raw : raw;
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(full);
  if (!m) return null;
  const [year, month, date, hour, minute, second] = m.slice(1).map(v => Number(v || 0));
  const utc = Date.UTC(year, month - 1, date, hour, minute, second);
  const candidates = [2, 3].map(offset => utc - offset * 3600000).filter(ms => {
    const p = parts(ms);
    return +p.year === year && +p.month === month && +p.day === date &&
      +p.hour === hour && +p.minute === minute && +p.second === second;
  });
  return candidates.length === 1 ? candidates[0] : null;
}
export function points(items) {
  return Object.fromEntries((Array.isArray(items) ? items : [])
    .filter(p => p && typeof p.key === 'string').map(p => [p.key, number(p.value)]));
}
export function threePhase(p) {
  return ['GridVoltageL1', 'GridVoltageL2', 'GridVoltageL3'].some(k => Object.hasOwn(p, k));
}
export function voltageState(p, prefix, three, frequency = null) {
  const keys = three ? [1, 2, 3].map(n => prefix + 'L' + n) : [prefix + 'L1L2'];
  const values = keys.map(k => number(p[k]));
  const hz = frequency ? number(p[frequency]) : null;
  if (values.some(v => v === null) || (frequency && hz === null)) return 'unknown';
  if (values.every(v => v >= 180 && v <= 260) && (!frequency || (hz >= 45 && hz <= 55))) return 'on';
  if (values.every(v => v >= 0 && v < 50) && (!frequency || (hz >= 0 && hz < 1))) return 'off';
  return 'unstable';
}
export function gridState(p, three = threePhase(p)) {
  return voltageState(p, 'GridVoltage', three, 'GridFrequency');
}
export function transitions(samples) {
  const grouped = new Map();
  for (const sample of samples) {
    if (!Number.isFinite(sample.time)) continue;
    const set = grouped.get(sample.time) ?? new Set();
    set.add(sample.state);
    grouped.set(sample.time, set);
  }
  let previous = null;
  const result = { appeared: null, disappeared: null };
  for (const [time, states] of [...grouped].sort((a, b) => a[0] - b[0])) {
    if (states.size !== 1) continue;
    const state = [...states][0];
    if (state !== 'on' && state !== 'off') continue;
    if (previous && previous.state !== state) {
      result[state === 'on' ? 'appeared' : 'disappeared'] = {
        from: previous.time, to: time, at: Math.round((previous.time + time) / 2)
      };
    }
    previous = { time, state };
  }
  return result;
}
function consensus(states) {
  if (!states.length || states.includes('unknown')) return 'unknown';
  return states.every(s => s === states[0]) ? states[0] : 'unstable';
}
export function summarize(station, latest, devices, now = Date.now()) {
  const measurements = devices.map(d => {
    const p = points(d.dataList);
    const three = threePhase(p);
    const time = parseTime(d.collectionTime);
    const fresh = time !== null && now - time >= -120000 && now - time <= STALE_MS;
    return {
      time, fresh, p, three,
      grid: gridState(p, three),
      output: voltageState(p, 'LoadVoltage', three),
      load: number(p.UPSLoadPower) ?? number(p.TotalConsumptionPower)
    };
  });
  const stale = !measurements.length || measurements.some(m => !m.fresh);
  const times = measurements.map(m => m.time);
  const collectedAt = times.length && times.every(t => t !== null) ? Math.min(...times) : null;
  const stationTime = parseTime(latest.lastUpdateTime);
  const stationFresh = stationTime !== null && now - stationTime >= -120000 && now - stationTime <= STALE_MS;
  let soc = measurements.length === 1 ? number(measurements[0].p.SOC) : null;
  if (soc === null && stationFresh) soc = number(latest.batterySOC);
  if (soc === null && measurements.length === 1) soc = number(measurements[0].p.SOC);
  if (soc !== null && (soc < 0 || soc > 100)) soc = null;
  const loads = measurements.map(m => m.load);
  const loadWatts = loads.length && loads.every(v => v !== null && v >= 0) ? loads.reduce((a, b) => a + b, 0) : null;
  const discharge = stationFresh ? number(latest.dischargePower) : null;
  const charge = stationFresh ? number(latest.chargePower) : null;
  let batteryMode = 'unknown';
  const limit = 70; // W: smaller battery power is treated as idle
  if (measurements.length === 1 && number(measurements[0].p.BatteryPower) !== null) {
    const power = measurements[0].p.BatteryPower;
    batteryMode = power > limit ? 'discharging' : power < -limit ? 'charging' : 'idle';
  } else if (discharge !== null && Math.abs(discharge) > limit && !(charge !== null && Math.abs(charge) > limit)) batteryMode = 'discharging';
  else if (charge !== null && Math.abs(charge) > limit && !(discharge !== null && Math.abs(discharge) > limit)) batteryMode = 'charging';
  else if (measurements.length === 1 && number(measurements[0].p.BatteryPower) !== null) {
    const power = measurements[0].p.BatteryPower;
    batteryMode = power > limit ? 'discharging' : power < -limit ? 'charging' : 'idle';
  }
  const allZero = measurements.length > 0 && measurements.every(m =>
    (m.three ? [1, 2, 3].map(n => 'GridVoltageL' + n) : ['GridVoltageL1L2'])
      .every(k => number(m.p[k]) === 0));
  return {
    station: { id: station.id, name: station.name },
    collectedAt, fetchedAt: now, stale,
    grid: stale ? 'unknown' : consensus(measurements.map(m => m.grid)),
    output: stale ? 'unknown' : consensus(measurements.map(m => m.output)),
    allPhasesZero: !stale && allZero,
    soc: stale ? null : soc, batteryMode: stale ? 'unknown' : batteryMode,
    loadWatts: stale ? null : loadWatts
  };
}
