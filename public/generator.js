import { formatDuration, formatElapsed, formatKw, formatLiters, shortDate, fullDate, timeOf, dateOf, weekday, shiftDay, kyivToday, isDay, dayRange,
  buildRows, statusLabel } from './generator-lib.js';

// Tabs "Паливо та ТО" and "Генератор" of the main page. Both are fed by one request (/api/generator-report),
// which is made only when one of these tabs is opened (the "Стан" tab does not need it).
const $ = id => document.getElementById(id);
const TABS = ['state', 'fuel', 'generator'];
const DEFAULT_DAYS = 7;
const RELOAD_AFTER_MS = 60000; // opening a tab again after this time asks for fresh data
let run = 0;            // a newer request cancels the older one
let tab = 'state';
let loadedAt = 0;       // when the report was last loaded
let loadedOnce = false;
let authNeeded = false;

// The password of the report is remembered in this browser (localStorage; if it is blocked, only until the page is closed).
const PASSWORD_KEY = 'c13-report-password';
class AuthError extends Error {}
function readPassword() { try { return localStorage.getItem(PASSWORD_KEY) || ''; } catch { return ''; } }
function savePassword(value) { try { localStorage.setItem(PASSWORD_KEY, value); } catch { /* kept in memory only */ } }
function forgetPassword() { try { localStorage.removeItem(PASSWORD_KEY); } catch { /* nothing to remove */ } }
let password = readPassword();

function apiBase() {
  const local = new URLSearchParams(location.search).get('api');
  // For testing: ?api=http://127.0.0.1:8787 (a Worker started on this computer). Only localhost is allowed.
  if (local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(local)) return local;
  return document.querySelector('meta[name="dashboard-api"]')?.content?.trim() || '';
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function setNote(text, kind = '') {
  const note = $('report-note');
  note.textContent = text;
  note.dataset.kind = kind;
  note.hidden = !text || tab === 'state';
  note.dataset.has = text ? '1' : '';
}

// ---------- Journal ----------

const refuelMark = refuel => el('div', 'refuel', 'Заправка ' + timeOf(refuel.atLocal) + ' · ' + formatLiters(refuel.liters) + (refuel.by ? ' · ' + refuel.by : ''));

// expand: when only one day is shown, its sessions are opened at once.
function renderRow(row, maxMinutes, expand = false) {
  const item = el('li', 'day');
  item.dataset.status = row.status;
  const head = el('div', 'day-head');
  const date = el('div', 'day-date');
  date.append(el('b', '', shortDate(row.date)), el('span', 'weekday', weekday(row.date)));
  head.append(date);
  if (row.status !== 'ok') {
    head.append(el('div', 'day-empty', statusLabel(row.status)));
    item.append(head);
    for (const refuel of row.refuels) item.append(refuelMark(refuel));
    return item;
  }
  const bar = el('div', 'bar');
  const fill = el('span');
  fill.style.width = Math.min(100, row.minutes / maxMinutes * 100) + '%';
  bar.append(fill);
  const total = el('div', 'day-total', row.minutes ? formatDuration(row.minutes) : '—');
  const meta = el('div', 'day-meta', row.starts ? row.starts + ' ' + (row.starts === 1 ? 'запуск' : 'запусків') + ' · до ' + formatKw(row.peakW) : 'не працював');
  head.append(bar, total, meta);
  item.append(head);
  for (const refuel of row.refuels) item.append(refuelMark(refuel));
  if (row.sessions.length) {
    const details = el('details', 'sessions');
    details.open = expand;
    details.append(el('summary', '', 'Сеанси'));
    const list = el('ul', 'session-list');
    const longest = Math.max(1, ...row.sessions.map(s => s.minutes));
    for (const s of row.sessions) {
      const li = el('li', 'session');
      if (s.open) li.dataset.open = '1';
      const time = el('span', 's-time');
      time.append(el('b', '', timeOf(s.startLocal)), el('span', 's-arrow', '→'));
      time.append(el('b', '', s.open ? 'працює' : timeOf(s.endLocal)));
      if (!s.open && dateOf(s.endLocal) !== row.date) time.append(el('span', 's-next', shortDate(dateOf(s.endLocal))));
      const sBar = el('span', 's-bar');
      const sFill = el('i');
      sFill.style.width = Math.max(6, s.minutes / longest * 100) + '%';
      sBar.append(sFill);
      li.append(time, sBar, el('span', 's-dur', formatDuration(s.minutes)), el('span', 's-power', formatKw(s.peakW)));
      list.append(li);
    }
    details.append(list);
    item.append(details);
  }
  return item;
}

function skeletonRows(count) {
  return Array.from({ length: count }, () => {
    const item = el('li', 'day skeleton');
    const head = el('div', 'day-head');
    head.append(el('span', 'sk sk-date'), el('span', 'sk sk-bar'), el('span', 'sk sk-total'));
    item.append(head);
    return item;
  });
}
function setLoader(text) {
  $('loader').dataset.on = text ? '1' : '';
  if (text) $('loader-text').textContent = text;
}
function markActivePreset(from, to) {
  const length = dayRange(from, to).length;
  for (const button of document.querySelectorAll('[data-days]'))
    button.dataset.active = to === kyivToday() && Number(button.dataset.days) === length ? '1' : '';
}

// ---------- Fuel and service indicators ----------

const INDICATOR_STALE_MIN = 30;
// The sections come from the Worker already cleaned (b/i/u/blockquote and t.me links only), so innerHTML is safe here.
function renderIndicators(indicators) {
  const list = $('ind-list');
  const at = $('ind-at');
  list.replaceChildren();
  at.textContent = '';
  at.dataset.kind = '';
  if (!indicators) {
    list.append(el('p', 'ind-empty', 'Показники ще не надходили.'));
    return;
  }
  const minutes = (Date.now() - indicators.at) / 60000;
  const when = new Date(indicators.at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  at.textContent = 'Пораховано ' + when + ' · ' + formatElapsed(minutes) + ' тому';
  at.dataset.kind = minutes > INDICATOR_STALE_MIN ? 'stale' : '';
  for (const section of indicators.sections) {
    const box = el('section', 'ind');
    const title = el('h3', 'ind-title', section.title);
    const body = el('div', 'ind-body');
    body.innerHTML = section.html;
    box.append(title, body);
    list.append(box);
  }
}

// ---------- Loading ----------

function render(data, from, to) {
  markActivePreset(from, to);
  renderIndicators(data.indicators);
  $('period-total').textContent = formatDuration(data.totalMinutes);
  $('period-starts').textContent = String(data.totalStarts);
  $('period-label').textContent = fullDate(from) + (from === to ? ', ' + weekday(from) : ' – ' + fullDate(to));
  const rows = buildRows(from, to, data);
  const maxMinutes = Math.max(60, ...rows.map(r => r.minutes));
  $('days').replaceChildren(...rows.map(row => renderRow(row, maxMinutes, rows.length === 1)));
}

async function fetchReport(base, from, to) {
  let response;
  const headers = password ? { 'X-Report-Password': encodeURIComponent(password) } : {};
  try { response = await fetch(base + '/api/generator-report?from=' + from + '&to=' + to, { cache: 'no-store', headers }); }
  catch { throw new Error('Немає зв’язку із сервером. Перевірте інтернет і спробуйте ще раз.'); }
  let data = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (response.status === 401) throw new AuthError(data?.error || 'Потрібен пароль.');
  if (!response.ok || !data) throw new Error((data && data.error) || 'Сервер повернув помилку (HTTP ' + response.status + ').');
  return data;
}

function showAuth(message) {
  authNeeded = true;
  $('auth-error').textContent = message || '';
  $('password').value = '';
  applyTab();
  $('password').focus();
}
function hideAuth() {
  authNeeded = false;
  $('auth-error').textContent = '';
  applyTab();
}

async function load(from, to) {
  if (document.documentElement.hasAttribute('data-maintenance')) return; // technical works: no requests
  const mine = ++run;
  const base = apiBase();
  if (!base) { setNote('Не вказано адресу сервера.', 'error'); return; }
  $('apply').disabled = true;
  $('period-label').textContent = fullDate(from) + (from === to ? ', ' + weekday(from) : ' – ' + fullDate(to));
  markActivePreset(from, to);
  setLoader('Завантажую дані…');
  setNote('');
  $('analysis').dataset.state = 'loading';
  try {
    const data = await fetchReport(base, from, to);
    if (mine !== run) return;
    if (password) savePassword(password); // saved only after the server accepted it
    hideAuth();
    render(data, from, to);
    loadedAt = Date.now();
    loadedOnce = true;
    $('updated').textContent = 'Оновлено ' + new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    $('analysis').dataset.state = 'ready';
  } catch (error) {
    if (mine !== run) return;
    if (error instanceof AuthError) {
      // A wrong remembered password is forgotten; the form asks for a new one.
      const wrong = Boolean(password);
      password = '';
      forgetPassword();
      showAuth(wrong ? error.message : '');
      return;
    }
    setNote(error.message, 'error');
    $('analysis').dataset.state = 'error';
    $('days').replaceChildren();
    $('ind-list').replaceChildren(el('p', 'ind-empty', 'Не вдалося завантажити показники.'));
  } finally {
    if (mine === run) { $('apply').disabled = false; setLoader(''); }
  }
}

// ---------- Period controls ----------

function readPeriod() {
  const from = $('from').value;
  const to = $('to').value;
  if (!isDay(from) || !isDay(to) || from > to) { setNote('Вкажіть коректний період.', 'error'); return null; }
  if (to > kyivToday()) { setNote('Кінець періоду не може бути в майбутньому.', 'error'); return null; }
  if (shiftDay(from, 31) <= to) { setNote('Період не може бути більшим за 31 день.', 'error'); return null; }
  return { from, to };
}
function preset(days) {
  const to = kyivToday();
  $('to').value = to;
  $('from').value = shiftDay(to, -(days - 1));
  load($('from').value, $('to').value);
}
const reload = () => load($('from').value, $('to').value);

// ---------- Tabs ----------

function tabFromHash() {
  const name = location.hash.slice(1);
  return TABS.includes(name) ? name : 'state';
}
// Shows the panes of the current tab; while the password is requested only the form is shown instead of the report.
function applyTab() {
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  for (const pane of document.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab || (authNeeded && tab !== 'state');
  $('auth').hidden = !(authNeeded && tab !== 'state');
  $('report-note').hidden = tab === 'state' || !$('report-note').dataset.has;
  $('forget').hidden = !password || tab === 'state' || authNeeded;
}
function showTab(name, updateAddress = true) {
  tab = name;
  applyTab();
  if (updateAddress) {
    try { history.replaceState(null, '', name === 'state' ? location.pathname + location.search : '#' + name); } catch { /* the address stays as it is */ }
  }
  // Data of the report are loaded when its tab is opened for the first time and again when they are older than a minute.
  if (name !== 'state' && !authNeeded && (!loadedOnce || Date.now() - loadedAt > RELOAD_AFTER_MS)) reload();
}

function start() {
  const today = kyivToday();
  $('to').max = today;
  $('from').max = today;
  $('to').value = today;
  $('from').value = shiftDay(today, -(DEFAULT_DAYS - 1));
  $('days').replaceChildren(...skeletonRows(2));

  for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => showTab(button.dataset.tab));
  // The link on the generator card (#fuel) and the browser's back button change the address: follow it.
  window.addEventListener('hashchange', () => showTab(tabFromHash(), false));

  $('controls').addEventListener('submit', event => {
    event.preventDefault();
    const period = readPeriod();
    if (period) load(period.from, period.to);
  });
  for (const button of document.querySelectorAll('[data-days]')) button.addEventListener('click', () => preset(Number(button.dataset.days)));
  $('auth-form').addEventListener('submit', event => {
    event.preventDefault();
    const typed = $('password').value;
    if (!typed) return;
    password = typed;
    $('auth-error').textContent = '';
    reload();
  });
  $('forget').addEventListener('click', () => {
    if (!confirm('Ви впевнені, що хочете забути пароль на цьому пристрої?\nДля наступного входу його потрібно буде ввести знову.')) return;
    password = '';
    forgetPassword();
    showAuth('');
  });
  // The refresh button of the page header reloads the report when one of its tabs is open (the state is refreshed by app.js).
  $('refresh').addEventListener('click', () => { if (tab !== 'state' && !authNeeded) reload(); });

  showTab(tabFromHash(), false);
}
start();
