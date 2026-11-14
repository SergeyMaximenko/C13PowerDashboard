// Data pushed by the C# application (ScheduleDisconnectLight). Contract: see INGEST.md.
export const SCHEMA_VERSION = 1;
export const STALE_MS = 30 * 60_000;
export const KV_SNAPSHOT = 'ingest:snapshot';
export const KV_JOURNAL = 'ingest:journal';
export const KV_REFUELS = 'ingest:refuels';

const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const flag = value => value === 0 || value === 1 ? value : null;
const hash = value => typeof value === 'string' && /^[A-Za-z0-9+/=_-]{1,128}$/.test(value) ? value : null;

// Whitelist: only known fields are stored, everything else in the request is dropped.
export function cleanSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = ['charging', 'discharging', 'idle'].includes(raw.batteryMode) ? raw.batteryMode : null;
  const snapshot = {
    requestAt: num(raw.requestAt), measuredAt: num(raw.measuredAt),
    gridStatus: flag(raw.gridStatus), gridDate: num(raw.gridDate), gridVoltage: num(raw.gridVoltage),
    genStatus: flag(raw.genStatus), genDate: num(raw.genDate), genPower: num(raw.genPower), genVoltage: num(raw.genVoltage), genPeak: num(raw.genPeak),
    inverterStatus: flag(raw.inverterStatus), inverterDate: num(raw.inverterDate), loadWatts: num(raw.loadWatts),
    soc: num(raw.soc), batteryMode: mode, batteryWatts: num(raw.batteryWatts)
  };
  return snapshot.measuredAt === null ? null : snapshot;
}

// KV allows 1000 writes a day, so the snapshot is not written on every run. It is written when:
//  - nothing is stored yet, or the stored record is unusable;
//  - a status changed (grid, generator, inverter): at once, however recently the last write was;
//  - the measurement time changed and the last write is at least SNAPSHOT_MIN_GAP_MS old.
// The gap is a little shorter than 2 minutes on purpose: the runs come about every 2 minutes with some jitter, and an exact
// 2 minutes would skip every second run (a write every 4 minutes). Worst case: 86400 / 110 = 785 writes a day.
export const SNAPSHOT_MIN_GAP_MS = 110_000;
const STATUS_KEYS = ['gridStatus', 'genStatus', 'inverterStatus'];
export function shouldWriteSnapshot(previous, snapshot, now) {
  const old = previous?.snapshot;
  if (!old || typeof old !== 'object') return true;
  if (STATUS_KEYS.some(key => old[key] !== snapshot[key])) return true;
  if (old.measuredAt === snapshot.measuredAt) return false;
  const gap = now - previous.receivedAt;
  return !Number.isFinite(gap) || gap < 0 || gap >= SNAPSHOT_MIN_GAP_MS; // a broken or future time must not block writes
}

// Journal row: { object: 'Світло'|'Генератор', at, onOff: 0|1, hoursPowerOff, hoursGenOn, test: bool }
export function cleanJournal(rows) {
  if (!Array.isArray(rows) || rows.length > 20000) return null;
  const result = [];
  for (const row of rows) {
    if (!row || !['Світло', 'Генератор'].includes(row.object) || num(row.at) === null || flag(row.onOff) === null) return null;
    result.push({
      object: row.object, at: row.at, onOff: row.onOff,
      hoursPowerOff: num(row.hoursPowerOff), hoursGenOn: num(row.hoursGenOn), peakW: num(row.peakW), test: row.test === true
    });
  }
  return result;
}

// Refuel row: { at, liters, by }
export function cleanRefuels(rows) {
  if (!Array.isArray(rows) || rows.length > 5000) return null;
  const result = [];
  for (const row of rows) {
    if (!row || num(row.at) === null) return null;
    result.push({ at: row.at, liters: num(row.liters), by: row.by ? String(row.by).slice(0, 40) : null });
  }
  return result.sort((a, b) => a.at - b.at);
}
export const cleanHash = hash;

// Snapshot -> the same shape the dashboard already reads from /api/status (see lib/public-status.mjs).
export function snapshotToStatus(snapshot, receivedAt, now) {
  if (!snapshot) return null;
  const state = value => value === 1 ? 'on' : value === 0 ? 'off' : 'unknown';
  const event = (appeared, at) => at !== null && snapshot.gridStatus === (appeared ? 1 : 0) ? { from: at, to: at, at } : null;
  return {
    station: { name: 'Чавдар 13' },
    collectedAt: snapshot.measuredAt, fetchedAt: receivedAt,
    diagnostics: { requestStartedAt: snapshot.requestAt, latestReceivedAt: receivedAt, completedAt: receivedAt,
      stationUpdatedAt: snapshot.measuredAt, fileCreatedAt: now },
    stale: now - snapshot.measuredAt > STALE_MS,
    grid: state(snapshot.gridStatus), output: state(snapshot.inverterStatus),
    allPhasesZero: snapshot.gridVoltage === 0, gridVoltage: snapshot.gridVoltage,
    soc: snapshot.soc, loadWatts: snapshot.loadWatts, batteryWatts: snapshot.batteryWatts,
    batteryMode: snapshot.batteryMode ?? 'unknown',
    generator: { state: snapshot.genStatus === 1 ? 'on' : snapshot.genStatus === 0 ? 'off' : 'unknown',
      powerW: snapshot.genPower, voltageV: snapshot.genVoltage },
    events: { appeared: event(true, snapshot.gridDate), disappeared: event(false, snapshot.gridDate) },
    historyAvailable: true
  };
}
