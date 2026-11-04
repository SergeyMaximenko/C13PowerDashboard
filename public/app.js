'use strict';
const $ = id => document.getElementById(id);
const clock = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit' });
const decimal = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
const STALE_AFTER_MS = 30 * 60000; // older data is "unknown" (keep equal to STALE_MS in lib/domain.mjs)
const WARN_AFTER_MS = 15 * 60000;  // the "Пройшло …" badge turns yellow
let snapshot = null, loading = false, requestVersion = 0, lastLoadedAt = 0, retries = 0;
let displayedMeasurementTime = null;
let displayedGridEvent = null;
const isExample = () => $('view-mode').value !== 'live';
// First load: grey bars in the cards and bouncing bubbles instead of the cloud-delay note.
function setLoading(on) {
  document.querySelector('.cards')?.classList.toggle('skeleton', on);
  document.querySelector('.freshness')?.classList.toggle('loading', on);
}
// SVG elements have no `hidden` property, only the attribute, so it is toggled directly.
function setHidden(element, on) {
  if (element.toggleAttribute) element.toggleAttribute('hidden', on); else element.hidden = on;
}
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function unknown(message) {
  render({ station: snapshot?.station, stale: true, collectedAt: snapshot?.collectedAt, grid: 'unknown', output: 'unknown', soc: null, events: {} });
  notice(message);
}
function inverterState(data, stale) {
  if (stale || !['on', 'off'].includes(data.grid) || !['on', 'off'].includes(data.output)) return 'unknown';
  // This dashboard follows the building's ATS scheme: mains has priority.
  // Nonzero output telemetry alone does not establish that the ATS feeds the building from the inverter.
  if (data.grid === 'on') {
    if (data.batteryMode === 'charging') return 'charging';
    if (data.output === 'off') return 'off';
    // With mains present the inverter does not feed the residents: small battery discharge is internal inverter activity.
    if (['idle', 'discharging'].includes(data.batteryMode)) return 'standby';
    return 'unknown';
  }
  const watts = data.loadWatts;
  const hasLoad = typeof watts === 'number' && Number.isFinite(watts) && watts > 0;
  const noLoad = watts === 0;
  if (data.output === 'on' && hasLoad) return 'supplying';
  if (data.output === 'off' && hasLoad) return 'unknown';
  if (noLoad && data.batteryMode === 'charging') return 'charging';
  if (data.output === 'off') return 'off';
  if (noLoad && ['idle', 'discharging'].includes(data.batteryMode)) return 'standby';
  return 'unknown';
}
function measurementAge(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  if (timestamp > now) return 'Час вимірювання попереду годинника';
  const seconds = Math.floor((now - timestamp) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return 'Пройшло ' + (hours ? hours + ' год. ' : '') + minutes + ' хв. ' + seconds % 60 + ' с.';
}
function updateMeasurementAge() {
  const element = $('data-elapsed');
  element.textContent = measurementAge(displayedMeasurementTime);
  element.hidden = !element.textContent;
  // Yellow once the data is older than 15 minutes (a normal delay is about 5 minutes).
  element.dataset.state = Number.isFinite(displayedMeasurementTime) && Date.now() - displayedMeasurementTime > WARN_AFTER_MS ? 'warn' : '';
}
function updateGridDuration() {
  const badge = $('grid-duration');
  const now = Date.now();
  const event = displayedGridEvent;
  const valid = event && Number.isFinite(event.at) && event.at > 0 && event.at <= event.measuredAt &&
    Number.isFinite(event.measuredAt) && now >= event.measuredAt && now - event.measuredAt <= STALE_AFTER_MS;
  badge.hidden = !valid;
  badge.textContent = valid ? (event.grid === 'on' ? 'Є вже ≈ ' : 'Немає вже ≈ ') +
    measurementAge(event.at, now).replace(/^Пройшло /, '') : '';
  if (!valid) $('grid-event').hidden = true;
}
function measurementDateLabel(timestamp, now = Date.now()) {
  const calendar = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const day = value => {
    const parts = Object.fromEntries(calendar.formatToParts(value).map(p => [p.type, p.value]));
    return parts.year + '-' + parts.month + '-' + parts.day;
  };
  const today = day(now);
  const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  const measured = day(timestamp);
  const label = measured === today ? 'сьогодні' : measured === yesterday ? 'вчора' :
    new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long',
      ...(measured.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {})
    }).format(timestamp);
  return 'Дані станом на ' + label + ' ' + clock.format(timestamp);
}
function render(data, example = false) {
  displayedMeasurementTime = data.collectedAt ?? null;
  updateMeasurementAge();
  const stale = data.stale || !data.collectedAt || Date.now() - data.collectedAt > STALE_AFTER_MS;
  const grid = stale ? 'unknown' : data.grid;
  const output = stale ? 'unknown' : data.output;
  const soc = stale ? null : data.soc;
  $('station-name').textContent = data.station?.name || 'Чавдар 13';
  $('source-text').textContent = example ? 'Демонстрація' : stale ? 'Немає свіжих даних' : 'Deye Cloud';
  $('source-pill').dataset.state = example ? 'demo' : stale ? 'unknown' : 'on';
  $('data-time').textContent = data.collectedAt ? measurementDateLabel(data.collectedAt) : 'Очікуємо дані';
  $('grid-card').dataset.state = grid;
  setHidden($('grid-icon'), grid === 'on');
  setHidden($('grid-anim'), grid !== 'on');
  $('grid-value').textContent = ({ on: 'Є', off: 'Немає', unstable: 'Нестабільна', unknown: 'Невідомо' })[grid] || 'Невідомо';
  $('grid-detail').textContent = grid === 'on' ? 'Напруга є на всіх фазах' :
    grid === 'off' ? (data.allPhasesZero ? 'Усі фази: 0 В' : 'Немає вхідної напруги') :
    grid === 'unstable' ? 'Перевірте стан фаз' : 'Немає актуальних показників';
  const event = data.historyError || data.historyAvailable === false ? null :
    grid === 'on' ? data.events?.appeared : grid === 'off' ? data.events?.disappeared : null;
  // The history only says that the state changed between two measurements (from..to). The midpoint is misleading after a gap in the data
  // (e.g. the link was lost), so the later measurement minus one minute is shown: the state had certainly changed by then.
  const eventAt = event ? (Number.isFinite(event.to) ? event.to - 60000 : event.at) : null;
  $('grid-event').hidden = !event;
  $('grid-event').textContent = event ? (grid === 'on' ? 'З’явилася ≈ ' : 'Зникла ≈ ') +
    (date.format(eventAt) !== date.format(data.collectedAt) ? date.format(eventAt) + ', ' : '') + clock.format(Math.round(eventAt / 60000) * 60000) : '';
  displayedGridEvent = event && !stale ? { at: eventAt, measuredAt: data.collectedAt, grid } : null;
  updateGridDuration();
  // Generator on the GEN input: shown only when the data says so (hidden when unknown or stale).
  const generator = stale ? 'unknown' : data.generator?.state;
  const generatorKnown = generator === 'on' || generator === 'starting' || generator === 'off';
  // The card appears once the station has reported generator data (stations without a generator never show it).
  if (generatorKnown) $('generator-card').dataset.seen = '1';
  // With stale data every tile is "unknown", so the generator tile stays too (otherwise it would vanish exactly when the link is lost).
  $('generator-card').hidden = !$('generator-card').dataset.seen && !stale;
  // "starting": the generator runs (voltage is present) but the inverter has not taken it yet, the battery still feeds the house.
  $('generator-card').dataset.state = generator === 'on' ? 'on' : generator === 'starting' ? 'unstable' : generatorKnown ? 'standby' : 'unknown';
  $('generator-value').textContent = generator === 'on' ? 'Працює' : generator === 'starting' ? 'Готується до роботи' : generatorKnown ? 'Зупинений' : 'Невідомо';
  setHidden($('generator-icon'), generator === 'on' || generator === 'starting');
  setHidden($('generator-anim'), generator !== 'on' && generator !== 'starting');
  $('generator-load').hidden = generator !== 'on';
  const generatorWatts = data.generator?.powerW;
  $('generator-power').textContent = !Number.isFinite(generatorWatts) ? '—' :
    decimal.format(generatorWatts < 1000 ? generatorWatts : generatorWatts / 1000);
  $('generator-unit').textContent = Number.isFinite(generatorWatts) && generatorWatts < 1000 ? 'Вт' : 'кВт';
  $('generator-detail').textContent = generator === 'on'
    ? (Number.isFinite(data.generator?.voltageV) ? 'Напруга генератора: ' + Math.round(data.generator.voltageV) + ' В' : 'Напруга є')
    : generator === 'starting' ? 'Генератор запущено, чекаємо підключення'
    : generatorKnown ? 'Генератор в режимі очікування' : 'Немає актуальних показників';
  const operation = inverterState(data, stale);
  $('output-card').dataset.state = ({ supplying: 'on', charging: 'on', standby: 'standby', off: 'off', unknown: 'unknown' })[operation];
  $('output-value').textContent = ({
    supplying: generator === 'on' ? 'Будинок живиться від генератора' : 'Будинок живиться від батареї',
    charging: 'Інвертор заряджає акумулятор',
    standby: 'Інвертор у режимі очікування',
    off: 'Немає напруги на виході',
    unknown: 'Стан невідомий'
  })[operation];
  // While the house is powered by the inverter the static icon becomes a small animated scene.
  const gears = operation === 'supplying' || operation === 'charging';
  setHidden($('inverter-icon'), gears);
  setHidden($('inverter-anim'), !gears);
  $('load').hidden = operation !== 'supplying';
  const watts = data.loadWatts;
  $('load-value').textContent = watts == null ? '—' :
    watts > 0 && watts < 1 ? '< 1' : decimal.format(watts < 1000 ? watts : watts / 1000);
  $('load-unit').textContent = watts != null && watts < 1000 ? 'Вт' : 'кВт';
  // The headline already says "Немає напруги на виході": do not repeat it below.
  $('output-detail').hidden = operation === 'off' || (output === 'on' && data.loadWatts != null);
  $('output-detail').textContent = output === 'on' ? 'Напруга на виході є' : output === 'off' ? 'Напруги на виході немає' :
    output === 'unstable' ? 'Показники напруги нестабільні' : 'Недостатньо актуальних показників';
  // Amber while the battery is discharging (red below 20%, as a warning); green otherwise.
  $('battery-card').dataset.state = soc == null ? 'unknown' : soc <= 20 ? 'off' :
    (soc <= 40 || (!stale && data.batteryMode === 'discharging')) ? 'unstable' : 'on';
  $('soc-value').textContent = soc == null ? '—' : decimal.format(soc);
  $('soc-percent').hidden = soc == null;
  $('battery-progress').hidden = soc == null;
  $('battery-progress').value = soc ?? 0;
  // Battery character replaces the static icon while charging (happy) or discharging (sleepy).
  const charging = !stale && data.batteryMode === 'charging', discharging = !stale && data.batteryMode === 'discharging';
  setHidden($('battery-icon'), charging || discharging);
  setHidden($('battery-mascot'), !(charging || discharging));
  setHidden($('mascot-charging'), !charging);
  setHidden($('mascot-sleeping'), !discharging);
  $('battery-card').dataset.mascot = charging || discharging ? 'on' : '';
  // The level loops over the whole battery: from empty to full while charging, from full to empty while discharging.
  // The real charge is the number on the card; the animation only shows the direction.
  $('battery-mascot').dataset.dir = discharging ? 'down' : 'up';
  // Power is shown next to the mode only while the battery really charges or discharges.
  const batteryWatts = Number.isFinite(data.batteryWatts) && (data.batteryMode === 'charging' || data.batteryMode === 'discharging') ? Math.abs(data.batteryWatts) : null;
  const batteryPower = batteryWatts === null ? '' :
    ' · ' + decimal.format(batteryWatts < 1000 ? batteryWatts : batteryWatts / 1000) + (batteryWatts < 1000 ? ' Вт' : ' кВт');
  $('battery-mode').textContent = stale ? 'Немає актуальних показників' :
    (({ discharging: 'Розряджається', charging: 'Заряджається', idle: 'У режимі очікування', unknown: 'Стан заряду невідомий' })[data.batteryMode] || 'Стан заряду невідомий') + batteryPower;
  // Warning for residents: the battery feeds the house and will switch off at 15%.
  $('battery-warning').hidden = !(!stale && grid === 'off' && data.batteryMode === 'discharging');
  $('update-note').textContent = example ? 'Демонстраційні значення для перегляду оформлення' : '';
  notice(example ? 'Приклад відображення — це не поточні показники будинку.' :
    stale ? (data.collectedAt
      ? 'Немає зв’язку з інвертором. Можливо, у підвалі, де він встановлений, пропав інтернет. Останні дані були ' +
        (date.format(data.collectedAt) !== date.format(Date.now()) ? date.format(data.collectedAt) + ' ' : '') +
        'о ' + clock.format(data.collectedAt) + ', тому поточний стан світла невідомий.'
      : 'Немає даних від інвертора. Можливо, у підвалі, де він встановлений, пропав інтернет. Поточний стан світла невідомий.') :
    '');
}
function example(mode) {
  const now = Date.now();
  const mains = mode === 'on' || mode === 'standby';
  return { station: { name: 'Чавдар 13' }, collectedAt: now - (mode === 'stale' ? 1860000 : 300000),
    stale: mode === 'stale', grid: mains ? 'on' : 'off', output: mode === 'output-off' ? 'off' : 'on',
    allPhasesZero: !mains, soc: mode === 'on' ? 82 : mode === 'standby' ? 100 : mode === 'output-off' ? 10 : 61,
    batteryMode: mode === 'on' || mode === 'generator' ? 'charging' : ['standby', 'output-off'].includes(mode) ? 'idle' : 'discharging',
    generator: { state: mode === 'generator' ? 'on' : mode === 'generator-start' ? 'starting' : 'off',
      powerW: mode === 'generator' ? 22000 : 0, voltageV: mode === 'generator' || mode === 'generator-start' ? 235 : 0 },
    loadWatts: mains || mode === 'output-off' ? 0 : 16800,
    batteryWatts: mode === 'on' || mode === 'generator' ? -33200 : ['standby', 'output-off'].includes(mode) ? 0 : 17100,
    events: { appeared: { at: now - 3600000 }, disappeared: { at: now - 10800000 } } };
}
async function api() {
  const query = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  // For testing: ?api=http://127.0.0.1:8787 reads from a Worker running on this computer (wrangler dev). Only localhost is allowed.
  const local = query.get('api');
  const apiUrl = local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(local) ? local
    : document.querySelector('meta[name="dashboard-api"]')?.content?.trim();
  if (!apiUrl) throw new Error('Не вказано адресу джерела даних.');
  const source = new URL('/api/status', apiUrl);
  // Optional: ?station=ID opens another station from the Worker's allowed list. Default: the main station.
  const station = query.get('station');
  if (station && /^\d{1,20}$/.test(station)) source.searchParams.set('station', station);
  let response;
  try { response = await fetch(source, { cache: 'no-store', signal: AbortSignal.timeout(45000) }); }
  catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? 'Сервер не відповів вчасно. Спробуємо ще раз.' : 'Немає зв’язку із сервером даних. Перевірте інтернет.');
  }
  if (!response.ok) throw new Error('Не вдалося отримати дані. Спробуйте пізніше.');
  const data = await response.json();
  if (!data || !Number.isFinite(data.collectedAt)) throw new Error('Немає коректного часу вимірювання.');
  return data;
}
async function refresh() {
  if (isExample() || loading) return;
  const version = requestVersion;
  loading = true; $('refresh').disabled = true; $('refresh').classList.add('spinning');
  // Skeleton only on the very first load: later refreshes keep the numbers on screen.
  if (!snapshot) { setLoading(true); $('data-time').textContent = 'Завантажуємо дані…'; }
  try {
    const data = await api();
    if (version !== requestVersion || isExample()) return;
    // Never show an older measurement than the one already on screen (different servers may answer out of order).
    if (snapshot && Number.isFinite(snapshot.collectedAt) && data.collectedAt < snapshot.collectedAt) return;
    snapshot = data; render(data);
    lastLoadedAt = Date.now(); retries = 0;
  } catch (error) {
    // After a failure try again a few times (10 s apart), then wait for the user.
    if (version === requestVersion && !isExample()) { unknown(error.message); if (retries++ < 3) setTimeout(refresh, 10000); }
  } finally {
    // An answer to an outdated request (the view was switched meanwhile) must not touch the state of the new one.
    if (version === requestVersion) { loading = false; $('refresh').disabled = false; $('refresh').classList.remove('spinning'); setLoading(false); }
  }
}
function showExample() {
  const mode = $('view-mode').value;
  setLoading(mode === 'loading');
  if (mode === 'loading') { render({ stale: true, collectedAt: null, grid: 'unknown', output: 'unknown', soc: null, events: {} }, true); $('generator-card').hidden = false; notice(''); $('data-time').textContent = 'Завантажуємо дані…'; }
  else render(example(mode), true);
}
$('refresh').addEventListener('click', () => {
  if (isExample()) return showExample();
  // Data loaded less than 10 s ago are already fresh: only play a short spin, send nothing.
  if (!loading && Date.now() - lastLoadedAt < 10000) {
    $('refresh').classList.add('spinning');
    setTimeout(() => { if (!loading) $('refresh').classList.remove('spinning'); }, 700);
    return;
  }
  refresh();
});
$('view-mode').addEventListener('change', () => {
  requestVersion++;
  if (isExample()) showExample();
  else {
    // Back to real data: show what we already have, or the loading state, and ask for fresh data. No yellow message.
    loading = false;
    if (snapshot) { setLoading(false); render(snapshot); }
    else {
      setLoading(true);
      render({ stale: true, collectedAt: null, grid: 'unknown', output: 'unknown', soc: null, events: {} });
      notice(''); $('data-time').textContent = 'Завантажуємо дані…';
    }
    refresh();
  }
});
refresh();
// No periodic polling: data are loaded when the page opens, on the refresh button, and when the user comes back
// to the page after a while (at most once a minute), so an idle page makes no requests.
setInterval(() => { updateMeasurementAge(); updateGridDuration(); }, 1000);
setInterval(() => {
  if (!isExample() && snapshot && Date.now() - snapshot.collectedAt > STALE_AFTER_MS) render(snapshot);
}, 15000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastLoadedAt > 60000) refresh();
});

const installHelp = $('install-help');
$('open-install-help').addEventListener('click', () => installHelp.showModal());
$('close-install-help').addEventListener('click', () => installHelp.close());
