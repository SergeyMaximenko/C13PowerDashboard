import { formatDuration, formatElapsed, formatKw, formatLiters, shortDate, fullDate, timeOf, dateOf, weekday, shiftDay, kyivToday, isDay, dayRange,
  buildRows, needsRetry, statusLabel, MAX_RETRIES } from './generator-lib.js';

const $ = id => document.getElementById(id);
let run = 0; // a newer request cancels the older one
let sinceAt = null; // time of the last refuel: "time passed" is refreshed every half a minute

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
  const note = $('note');
  note.textContent = text;
  note.dataset.kind = kind;
  note.hidden = !text;
}

function renderSince(data) {
  const since = data.since;
  const card = $('since');
  const facts = $('since-facts');
  card.dataset.state = since ? (since.complete ? 'ok' : 'loading') : 'none';
  facts.replaceChildren();
  facts.hidden = true;
  if (!data.refuelsConfigured) {
    $('since-value').textContent = '—';
    $('since-detail').textContent = 'Таблицю заправок не підключено.';
    return;
  }
  if (!since) {
    $('since-value').textContent = '—';
    $('since-detail').textContent = data.refuelsError || 'У таблиці немає жодної заправки.';
    return;
  }
  $('since-value').textContent = formatDuration(since.minutes);
  // Three highlighted facts: the last refuel, how much was poured, how many starts since then.
  const fact = (kind, label, value, suffix) => {
    const tile = el('div', 'fact');
    tile.dataset.kind = kind;
    const big = el('b', 'fact-value');
    big.append(el('span', 'fact-text', value));
    const title = el('span', 'fact-label', label);
    if (suffix) title.append(' ', el('small', 'fact-suffix', suffix)); // small lowercase note after the label
    tile.append(title, big);
    return tile;
  };
  facts.append(fact('refuel', 'Остання заправка', fullDate(dateOf(since.refuel.atLocal)) + ' ' + timeOf(since.refuel.atLocal)));
  sinceAt = since.refuel.at;
  facts.append(fact('elapsed', 'Пройшло часу', formatElapsed((Date.now() - sinceAt) / 60000), 'після заправки'));
  if (since.refuel.liters !== null && since.refuel.liters !== undefined) facts.append(fact('liters', 'Заправлено', formatLiters(since.refuel.liters)));
  if (since.refuel.by) facts.append(fact('by', 'Заправляв', since.refuel.by));
  facts.append(fact('starts', 'Запусків за цей час', String(since.starts)));
  facts.hidden = false;
  const notes = [];
  if (since.open) notes.push('Генератор працює зараз.');
  if (!since.complete) notes.push('Частина днів ще завантажується…');
  if (since.truncated) notes.push('Пораховано лише за останні 120 днів.');
  $('since-detail').textContent = notes.join(' ');
}

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
  for (const refuel of row.refuels) {
    item.append(el('div', 'refuel', 'Заправка ' + timeOf(refuel.atLocal) + ' · ' + formatLiters(refuel.liters) + (refuel.by ? ' · ' + refuel.by : '')));
  }
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
      const bar = el('span', 's-bar');
      const fill = el('i');
      fill.style.width = Math.max(6, s.minutes / longest * 100) + '%';
      bar.append(fill);
      li.append(time, bar, el('span', 's-dur', formatDuration(s.minutes)), el('span', 's-power', formatKw(s.peakW)));
      list.append(li);
    }
    details.append(list);
    item.append(details);
  }
  return item;
}

// Loading visuals: skeleton cards until the first data arrive, and a small "bubbles" indicator while anything is loading.
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

function renderRefuel(refuel) {
  const item = el('li', 'refuel-item');
  item.append(el('span', 'r-icon', '⛽'));
  const when = el('span', 'r-when');
  when.append(el('b', '', fullDate(dateOf(refuel.atLocal))), el('span', 'r-time', weekday(dateOf(refuel.atLocal)) + ', ' + timeOf(refuel.atLocal)));
  item.append(when, el('span', 'r-liters', formatLiters(refuel.liters)));
  if (refuel.by) item.append(el('span', 'r-by', refuel.by));
  return item;
}

function render(data, from, to) {
  $('report').removeAttribute('data-first');
  markActivePreset(from, to);
  renderSince(data);
  $('period-total').textContent = formatDuration(data.totalMinutes);
  $('period-starts').textContent = String(data.totalStarts);
  $('period-label').textContent = fullDate(from) + ' – ' + fullDate(to);
  const rows = buildRows(from, to, data);
  const maxMinutes = Math.max(60, ...rows.map(r => r.minutes));
  $('days').replaceChildren(...rows.map(row => renderRow(row, maxMinutes, rows.length === 1)));
  $('refuels').replaceChildren(...(data.refuels ?? []).slice().reverse().map(renderRefuel));
  // The list of refuels is hidden for one day: the refuel is already shown inside the day card.
  $('refuels-block').hidden = !(data.refuels ?? []).length || rows.length === 1;
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

function endBoot() { $('report').removeAttribute('data-boot'); }
function showAuth(message) {
  endBoot();
  $('report').dataset.auth = '1';
  $('auth').hidden = false;
  $('auth-error').textContent = message || '';
  $('forget').hidden = true;
  $('password').value = '';
  $('password').focus();
}
function hideAuth() {
  $('report').removeAttribute('data-auth');
  $('auth').hidden = true;
  $('auth-error').textContent = '';
  $('forget').hidden = !password;
}

async function load(from, to) {
  const mine = ++run;
  const base = apiBase();
  if (!base) { endBoot(); setNote('Не вказано адресу сервера.', 'error'); return; }
  $('apply').disabled = true;
  $('report').dataset.state = 'loading';
  $('period-label').textContent = fullDate(from) + ' – ' + fullDate(to);
  markActivePreset(from, to);
  setLoader('Завантажую дані…');
  setNote('');
  try {
    let data = await fetchReport(base, from, to);
    for (let attempt = 1; needsRetry(data) && attempt <= MAX_RETRIES && mine === run; attempt++) {
      render(data, from, to);
      setLoader('Довантажую дані з Deye… (' + attempt + ')');
      await new Promise(resolve => setTimeout(resolve, 1200));
      if (mine !== run) return;
      data = await fetchReport(base, from, to);
    }
    if (mine !== run) return;
    if (password) savePassword(password); // saved only after the server accepted it
    endBoot();
    hideAuth();
    render(data, from, to);
    if (needsRetry(data)) setNote('Частину днів ще не завантажено. Натисніть «Показати» ще раз.', 'warn');
    else if (data.refuelsError) setNote(data.refuelsError, 'warn');
    else setNote('');
    $('updated').textContent = 'Оновлено ' + new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    $('report').dataset.state = 'ready';
  } catch (error) {
    if (mine !== run) return;
    $('report').removeAttribute('data-first');
    endBoot();
    if (error instanceof AuthError) {
      // A wrong remembered password is forgotten; the form asks for a new one.
      const wrong = Boolean(password);
      password = '';
      forgetPassword();
      showAuth(wrong ? error.message : '');
      return;
    }
    setNote(error.message, 'error');
    $('report').dataset.state = 'error';
    $('days').replaceChildren();
    $('since-value').textContent = '—';
  } finally {
    if (mine === run) { $('apply').disabled = false; setLoader(''); }
  }
}

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

function start() {
  const today = kyivToday();
  $('to').max = today;
  $('from').max = today;
  $('to').value = today;
  $('from').value = shiftDay(today, -6); // by default the last 7 days
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
    $('report').dataset.state = 'loading';
    load($('from').value, $('to').value);
  });
  $('forget').addEventListener('click', () => {
    if (!confirm('Ви впевнені, що хочете забути пароль на цьому пристрої?\nДля наступного входу його потрібно буде ввести знову.')) return;
    password = '';
    forgetPassword();
    showAuth('');
  });
  $('days').replaceChildren(...skeletonRows(5));
  setInterval(() => {
    const value = document.querySelector('.fact[data-kind="elapsed"] .fact-text');
    if (value && sinceAt !== null) value.textContent = formatElapsed((Date.now() - sinceAt) / 60000);
  }, 30000);
  // A remembered password is most likely valid: show the page with its loading skeleton at once.
  // Without it the page stays blank until the server answers (a password form instead of a skeleton that disappears).
  if (password) endBoot();
  load($('from').value, $('to').value);
}
start();
