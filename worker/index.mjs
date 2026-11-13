import { DeyeClient } from '../lib/deye.mjs';
import { publicStatus } from '../lib/public-status.mjs';
import { dayAt } from '../lib/domain.mjs';
import { buildSessions, summarizeDay, shiftDay, mergeAcrossMidnight, clipSessions } from '../lib/generator.mjs';
import { parseRefuels } from '../lib/refuels.mjs';

const DEFAULT_CACHE_SECONDS = 30;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GENERATOR_MAX_DAYS = 31;
const GENERATOR_NEW_DAYS_PER_REQUEST = 7; // ~3 Deye calls per day; the free plan allows 50 subrequests per request
const GENERATOR_TODAY_SECONDS = 600;
const GENERATOR_SINCE_MAX_DAYS = 120; // how far back "since the last refuel" is calculated
const REFUELS_SECONDS = 600;

function seconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
// Compares secrets without stopping at the first difference.
function sameSecret(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) difference |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return difference === 0;
}
export function settingsFromEnv(env) {
  const fields = { appId: 'DEYE_APP_ID', appSecret: 'DEYE_APP_SECRET', login: 'DEYE_LOGIN',
    password: 'DEYE_PASSWORD', stationId: 'DEYE_STATION_ID' };
  const settings = {};
  for (const [key, name] of Object.entries(fields)) {
    if (!String(env[name] ?? '').trim()) throw new Error('Missing configuration: ' + name);
    settings[key] = String(env[name]);
  }
  settings.stationName = env.DEYE_STATION_NAME || 'Чавдар 13';
  return settings;
}
// ALLOWED_STATION_IDS: "61167187:Моя станція,12345" — станції, які можна відкрити через ?station=ID.
export function allowedStations(env) {
  const result = new Map();
  for (const entry of String(env.ALLOWED_STATION_IDS ?? '').split(',')) {
    const [id, ...name] = entry.split(':');
    if (/^\d{1,20}$/.test(id.trim())) result.set(id.trim(), name.join(':').trim() || 'Станція ' + id.trim());
  }
  return result;
}

// State lives while the Worker isolate is warm: token, history and the last answer are reused per station.
export function createHandler({ clientFactory = (settings, options) => new DeyeClient(settings, undefined, options), now = Date.now } = {}) {
  const entries = new Map();

  function headers(env, extra = {}) {
    return {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Report-Password',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    };
  }
  function send(env, status, data, extra) {
    return new Response(JSON.stringify(data), { status, headers: headers(env, extra) });
  }
  function entryFor(env, requestedStation) {
    const base = settingsFromEnv(env);
    let settings = base;
    if (requestedStation && requestedStation !== base.stationId) {
      const name = allowedStations(env).get(requestedStation);
      if (!name) return null;
      settings = { ...base, stationId: requestedStation, stationName: name };
    }
    const key = JSON.stringify(settings);
    let entry = entries.get(settings.stationId);
    if (!entry || entry.key !== key) {
      // Only plain data is kept between requests (answer, token, history). Never a promise: see lib/deye.mjs.
      entry = { key, settings, cache: null, shared: { token: null, expiresAt: 0, historyCache: new Map() },
        generator: { days: new Map(), empty: new Set(), today: null } };
      entries.set(settings.stationId, entry);
      if (entries.size > 10) entries.delete(entries.keys().next().value);
    }
    return entry;
  }

  // Generator runs for a period: /api/generator?from=YYYY-MM-DD&to=YYYY-MM-DD (Kyiv days, at most 31).
  // Finished days never change: they are computed once and kept (memory, and KV when the GEN binding exists).
  // Only today is recalculated (every GENERATOR_TODAY_SECONDS). Deye calls per request are limited, the rest stays "pending".
  async function generatorReport(env, entry, url) {
    const today = dayAt(now());
    const to = url.searchParams.get('to') || today;
    const from = url.searchParams.get('from') || shiftDay(to, -6);
    const valid = day => validDay(day);
    if (!valid(from) || !valid(to) || from > to) return send(env, 400, { error: 'Вкажіть період: from і to у форматі РРРР-ММ-ДД.' });
    if (to > today) return send(env, 400, { error: 'Дата "to" не може бути в майбутньому.' });
    const days = [];
    for (let day = from; day <= to && days.length <= GENERATOR_MAX_DAYS; day = shiftDay(day, 1)) days.push(day);
    if (days.length > GENERATOR_MAX_DAYS) return send(env, 400, { error: 'Період не може бути більшим за ' + GENERATOR_MAX_DAYS + ' днів.' });

    const { result, missingDays } = await collectDays(env, entry, days, today, { left: GENERATOR_NEW_DAYS_PER_REQUEST });
    // Days stay as calculated (minutes per calendar day); the list of runs joins a run that crosses midnight.
    const sessions = publicSessions(result.flatMap(d => d.sessions));
    return send(env, 200, {
      from, to, timezone: 'Europe/Kyiv',
      totalMinutes: result.reduce((sum, d) => sum + d.minutes, 0),
      totalStarts: sessions.length,
      sessions,
      days: result.map(({ sessions, ...day }) => day),
      missingDays
    });
  }

  const publicSessions = sessions => mergeAcrossMidnight(sessions).map(({ cut, ...session }) => session);
  const dayList = (from, to, limit) => {
    const days = [];
    for (let day = from; day <= to && days.length <= limit; day = shiftDay(day, 1)) days.push(day);
    return days;
  };
  const validDay = day => DAY_PATTERN.test(day) && Number.isFinite(Date.parse(day + 'T12:00:00Z'))
    && new Date(day + 'T12:00:00Z').toISOString().slice(0, 10) === day; // 2026-02-30 is not a day

  // Summaries of the given days: memory -> KV -> Deye. `budget.left` limits how many NEW finished days one request may load.
  async function collectDays(env, entry, days, today, budget) {
    const state = entry.generator;
    const todayTtl = seconds(env.GENERATOR_TODAY_SECONDS, GENERATOR_TODAY_SECONDS) * 1000;
    const client = clientFactory(entry.settings, { shared: entry.shared });
    const result = [];
    const missingDays = [];
    for (const date of days) {
      const isToday = date === today;
      const kvKey = 'gen:v2:' + entry.settings.stationId + ':' + date; // v2: sessions carry the "cut" flag
      let summary = null;
      if (isToday) {
        if (state.today && state.today.date === date && now() - state.today.at < todayTtl) summary = state.today.summary;
      } else {
        summary = state.days.get(date) || null;
        if (!summary && env.GEN) {
          try { summary = await env.GEN.get(kvKey, 'json'); } catch { summary = null; }
          if (summary) state.days.set(date, summary);
        }
        if (!summary && state.empty.has(date)) { missingDays.push({ date, reason: 'no-data' }); continue; }
      }
      if (!summary) {
        if (!isToday && budget.left <= 0) { missingDays.push({ date, reason: 'pending' }); continue; }
        if (!isToday) budget.left--;
        let samples;
        try { samples = await client.generatorSamples(entry.settings.stationId, date); }
        catch (error) { missingDays.push({ date, reason: 'error', message: String(error?.message ?? error).slice(0, 300) }); continue; }
        if (!samples.length) {
          if (!isToday) state.empty.add(date);
          missingDays.push({ date, reason: 'no-data' });
          continue;
        }
        summary = summarizeDay(date, buildSessions(samples, { now: now(), allowOpen: isToday }));
        if (isToday) state.today = { date, at: now(), summary };
        else {
          state.days.set(date, summary);
          if (state.days.size > 200) state.days.delete(state.days.keys().next().value);
          if (env.GEN) { try { await env.GEN.put(kvKey, JSON.stringify(summary)); } catch { /* KV is optional */ } }
        }
      }
      result.push(summary);
    }
    return { result, missingDays };
  }

  // Refuels from the Google Sheet (published CSV). The link is a secret (REFUELS_CSV_URL), never sent to the browser.
  async function loadRefuels(env) {
    if (!String(env.REFUELS_CSV_URL ?? '').trim()) return { configured: false, refuels: [], error: null };
    const ttl = seconds(env.REFUELS_SECONDS, REFUELS_SECONDS) * 1000;
    if (refuelCache && now() - refuelCache.at < ttl) return { configured: true, refuels: refuelCache.refuels, error: null };
    try {
      const response = await fetch(env.REFUELS_CSV_URL, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const refuels = parseRefuels(await response.text());
      refuelCache = { at: now(), refuels };
      return { configured: true, refuels, error: null };
    } catch (error) {
      // Keep serving the last good table; the message never contains the link.
      const message = 'Не вдалося прочитати таблицю заправок: ' + String(error?.message ?? error).replace(/https?:\/\/\S+/g, '[посилання]').slice(0, 400);
      return { configured: true, refuels: refuelCache?.refuels ?? [], error: message };
    }
  }
  let refuelCache = null;
  const publicRefuel = ({ at, atLocal, liters, by }) => ({ at, atLocal, liters, by: by ?? null });

  // Report: days of the period with refuel marks + running time since the last refuel.
  // /api/generator-report?from=&to=  (default: the last 7 days; at most 31 days)
  async function fullReport(env, entry, url) {
    const today = dayAt(now());
    const to = url.searchParams.get('to') || today;
    const from = url.searchParams.get('from') || shiftDay(to, -6);
    if (!validDay(from) || !validDay(to) || from > to) return send(env, 400, { error: 'Вкажіть період: from і to у форматі РРРР-ММ-ДД.' });
    if (to > today) return send(env, 400, { error: 'Дата "to" не може бути в майбутньому.' });
    const windowDays = dayList(from, to, GENERATOR_MAX_DAYS);
    if (windowDays.length > GENERATOR_MAX_DAYS) return send(env, 400, { error: 'Період не може бути більшим за ' + GENERATOR_MAX_DAYS + ' днів.' });

    const table = await loadRefuels(env);
    const last = table.refuels.filter(r => r.at <= now()).at(-1) ?? null;
    let sinceFrom = last ? dayAt(last.at) : null;
    let truncated = false;
    const limit = shiftDay(today, -(GENERATOR_SINCE_MAX_DAYS - 1));
    if (sinceFrom && sinceFrom < limit) { sinceFrom = limit; truncated = true; }
    const sinceDays = sinceFrom ? dayList(sinceFrom, today, GENERATOR_SINCE_MAX_DAYS + 1) : [];

    // One budget for everything; the period requested by the user comes first, then the days since the refuel.
    const budget = { left: GENERATOR_NEW_DAYS_PER_REQUEST };
    const main = await collectDays(env, entry, windowDays, today, budget);
    const extraDays = sinceDays.filter(day => !windowDays.includes(day));
    const extra = await collectDays(env, entry, extraDays, today, budget);
    const summaries = new Map([...main.result, ...extra.result].map(d => [d.date, d]));
    const missing = [...main.missingDays, ...extra.missingDays];

    const sessions = publicSessions(main.result.flatMap(d => d.sessions));
    const days = main.result.map(({ sessions: _sessions, ...day }) => ({
      ...day, refuels: table.refuels.filter(r => dayAt(r.at) === day.date).map(publicRefuel)
    }));
    let since = null;
    if (last) {
      const sinceSessions = clipSessions(publicSessions(sinceDays.flatMap(day => summaries.get(day)?.sessions ?? [])), last.at);
      const minutes = sinceSessions.reduce((sum, s) => sum + s.minutes, 0);
      const gaps = missing.filter(m => sinceDays.includes(m.date) && m.reason !== 'no-data');
      since = {
        refuel: publicRefuel(last), minutes, hours: Math.round(minutes / 6) / 10, starts: sinceSessions.length,
        open: sinceSessions.some(s => s.open), truncated,
        complete: gaps.length === 0 // false: some days are still being loaded (pending/error), repeat the request
      };
    }
    return send(env, 200, {
      from, to, timezone: 'Europe/Kyiv',
      totalMinutes: main.result.reduce((sum, d) => sum + d.minutes, 0),
      totalStarts: sessions.length,
      days, sessions, since,
      refuels: table.refuels.filter(r => dayAt(r.at) >= from && dayAt(r.at) <= to).map(publicRefuel),
      refuelsConfigured: table.configured, refuelsError: table.error,
      missingDays: missing.filter(m => windowDays.includes(m.date))
    });
  }

  // The generator report (names of the people who refuelled) is protected by the password REPORT_PASSWORD (a Cloudflare secret).
  // The page sends it in X-Report-Password (URL-encoded) and remembers it in the browser. Without the secret the report stays open.
  // Wrong attempts are limited per address (while the isolate lives): 10 in 10 minutes, then 429.
  const failures = new Map();
  function checkPassword(request, env) {
    const expected = String(env.REPORT_PASSWORD ?? '');
    if (!expected) return null;
    const who = request.headers.get('CF-Connecting-IP') || 'unknown';
    const record = failures.get(who);
    if (record && now() - record.since > 600000) failures.delete(who);
    if ((failures.get(who)?.count ?? 0) >= 10)
      return send(env, 429, { error: 'Забагато спроб. Спробуйте за кілька хвилин.', auth: 'blocked' });
    const header = request.headers.get('X-Report-Password');
    let given = '';
    try { given = decodeURIComponent(header ?? ''); } catch { given = ''; }
    if (header !== null && sameSecret(given, expected)) { failures.delete(who); return null; }
    if (header !== null) {
      const current = failures.get(who) ?? { count: 0, since: now() };
      current.count++;
      failures.set(who, current);
      if (failures.size > 500) failures.delete(failures.keys().next().value);
    }
    return send(env, 401, { error: header === null ? 'Потрібен пароль.' : 'Невірний пароль.', auth: 'required' });
  }

  return async function handle(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(env) });
    if (request.method !== 'GET') return send(env, 405, { error: 'Дозволено лише GET.' });
    if (url.pathname === '/' || url.pathname === '/health') return send(env, 200, { ok: true });
    if (!['/api/status', '/api/generator', '/api/generator-report'].includes(url.pathname)) return send(env, 404, { error: 'Не знайдено.' });
    if (url.pathname !== '/api/status') {
      const denied = checkPassword(request, env);
      if (denied) return denied;
    }

    let entry;
    try { entry = entryFor(env, (url.searchParams.get('station') || '').trim()); }
    catch { return send(env, 500, { error: 'Worker не налаштований: перевірте змінні та секрети.' }); }
    if (!entry) return send(env, 403, { error: 'Ця станція недоступна.' });
    if (url.pathname === '/api/generator') return generatorReport(env, entry, url);
    if (url.pathname === '/api/generator-report') return fullReport(env, entry, url);

    const ttl = seconds(env.CACHE_SECONDS, DEFAULT_CACHE_SECONDS) * 1000;
    if (entry.cache && now() - entry.cache.at < ttl)
      return send(env, 200, entry.cache.data, { 'X-Cache': 'HIT', 'X-Cache-Age': String(Math.round((now() - entry.cache.at) / 1000)) });

    // Data-centre cache: shared by all isolates there, so a cold isolate does not call Deye again.
    const edgeKey = typeof caches !== 'undefined' && caches.default
      ? new Request('https://c13-power.internal/status/' + encodeURIComponent(entry.settings.stationId)) : null;
    if (edgeKey) {
      try {
        const hit = await caches.default.match(edgeKey);
        const saved = hit ? await hit.json() : null;
        if (saved && Number.isFinite(saved.at) && now() - saved.at < ttl) {
          entry.cache = saved;
          return send(env, 200, saved.data, { 'X-Cache': 'EDGE', 'X-Cache-Age': String(Math.round((now() - saved.at) / 1000)) });
        }
      } catch { /* the edge cache is optional */ }
    }

    try {
      // Every request makes its own call. Parallel misses are rare and the cache above limits the rate.
      const client = clientFactory(entry.settings, { shared: entry.shared });
      const data = await client.dashboard();
      entry.cache = { at: now(), data: publicStatus({ ...data, diagnostics: { ...data.diagnostics, fileCreatedAt: now() } }) };
      if (edgeKey) {
        try {
          await caches.default.put(edgeKey, new Response(JSON.stringify(entry.cache), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + Math.max(1, Math.ceil(ttl / 1000)) } }));
        } catch { /* ignore */ }
      }
      return send(env, 200, entry.cache.data, { 'X-Cache': 'MISS', 'X-Cache-Age': '0' });
    } catch {
      // Keep serving the last good answer: the page itself marks old measurements as stale.
      if (entry.cache) return send(env, 200, entry.cache.data, { 'X-Cache': 'STALE', 'X-Cache-Age': String(Math.round((now() - entry.cache.at) / 1000)) });
      return send(env, 502, { error: 'Не вдалося отримати дані Deye.' });
    }
  };
}

const handle = createHandler();
export default { fetch: (request, env) => handle(request, env) };
