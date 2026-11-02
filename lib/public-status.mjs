// Explicit allowlist: never publish full API responses, credentials or error text.
export function publicStatus(data) {
  const event = value => value && [value.from, value.to, value.at].every(Number.isFinite)
    ? { from: value.from, to: value.to, at: value.at } : null;
  const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    station: { name: String(data.station?.name || 'Чавдар 13') },
    collectedAt: numeric(data.collectedAt), fetchedAt: numeric(data.fetchedAt),
    diagnostics: Object.fromEntries(['requestStartedAt', 'latestReceivedAt', 'completedAt', 'stationUpdatedAt', 'fileCreatedAt', 'runId', 'runAttempt'].map(key => [key, numeric(data.diagnostics?.[key])])),
    stale: data.stale !== false,
    grid: ['on', 'off', 'unstable'].includes(data.grid) ? data.grid : 'unknown',
    output: ['on', 'off', 'unstable'].includes(data.output) ? data.output : 'unknown',
    allPhasesZero: data.allPhasesZero === true,
    soc: numeric(data.soc), loadWatts: numeric(data.loadWatts), batteryWatts: numeric(data.batteryWatts),
    batteryMode: ['charging', 'discharging', 'idle'].includes(data.batteryMode) ? data.batteryMode : 'unknown',
    generator: {
      state: ['on', 'off'].includes(data.generator?.state) ? data.generator.state : 'unknown',
      powerW: numeric(data.generator?.powerW), voltageV: numeric(data.generator?.voltageV)
    },
    events: { appeared: event(data.events?.appeared), disappeared: event(data.events?.disappeared) },
    historyAvailable: data.historyAvailable === true,
    historyError: data.historyError ? 'Історія тимчасово недоступна.' : undefined
  };
}
