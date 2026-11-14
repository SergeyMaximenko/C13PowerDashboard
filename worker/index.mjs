import { publicStatus } from '../lib/public-status.mjs';
import { dayAt } from '../lib/domain.mjs';
import { shiftDay, localText } from '../lib/generator.mjs';
import { sessionsFromJournal, summarizeDayFromSessions } from '../lib/journal-sessions.mjs';
import { parseIndicators } from '../lib/indicators.mjs';
import { SCHEMA_VERSION, KV_SNAPSHOT, KV_JOURNAL, KV_REFUELS, cleanSnapshot, cleanJournal, cleanRefuels, cleanHash, snapshotToStatus, shouldWriteSnapshot } from '../lib/ingest.mjs';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GENERATOR_MAX_DAYS = 31;

// Compares secrets without stopping at the first difference.
function sameSecret(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) difference |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return difference === 0;
}

// All data comes from the C# application (ingest) and lives in KV (binding DATA). The Worker never calls Deye.
export function createHandler({ now = Date.now } = {}) {
  function headers(env, extra = {}) {
    return {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Report-Password, X-Ingest-Secret, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    };
  }
  function send(env, status, data, extra) {
    return new Response(JSON.stringify(data), { status, headers: headers(env, extra) });
  }

  const validDay = day => DAY_PATTERN.test(day) && Number.isFinite(Date.parse(day + 'T12:00:00Z'))
    && new Date(day + 'T12:00:00Z').toISOString().slice(0, 10) === day; // 2026-02-30 is not a day
  const dayList = (from, to) => {
    const days = [];
    for (let day = from; day <= to && days.length <= GENERATOR_MAX_DAYS; day = shiftDay(day, 1)) days.push(day);
    return days;
  };
  const publicRefuel = ({ at, liters, by }) => ({ at, atLocal: localText(at), liters, by: by ?? null });

  // ---- Ingest: data pushed by the C# application (contract: INGEST.md) ----
  const ingestFailures = new Map();
  async function ingest(request, env, url) {
    if (!env.DATA) return send(env, 500, { error: 'KV не налаштований.' });
    const expected = String(env.INGEST_SECRET ?? '');
    const who = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!expected) return send(env, 500, { error: 'INGEST_SECRET не налаштований.' });
    if ((ingestFailures.get(who) ?? 0) >= 20) return send(env, 429, { error: 'Забагато спроб.' });
    if (!sameSecret(request.headers.get('X-Ingest-Secret') ?? '', expected)) {
      ingestFailures.set(who, (ingestFailures.get(who) ?? 0) + 1);
      if (ingestFailures.size > 500) ingestFailures.delete(ingestFailures.keys().next().value);
      return send(env, 401, { error: 'Невірний секрет.' });
    }
    let body;
    try {
      if (Number(request.headers.get('Content-Length') ?? 0) > 2_000_000) throw new Error('large');
      body = await request.json();
    } catch { return send(env, 400, { error: 'Некоректний JSON.' }); }
    if (body?.schemaVersion !== SCHEMA_VERSION) return send(env, 409, { error: 'Непідтримувана schemaVersion.' });

    if (url.pathname === '/api/ingest') {
      const snapshot = cleanSnapshot(body.snapshot);
      if (!snapshot) return send(env, 400, { error: 'Некоректний snapshot.' });
      const previous = await env.DATA.get(KV_SNAPSHOT, 'json');
      const old = previous?.snapshot;
      // Indicators (generator text) travel inside the snapshot and are saved in the same KV key (one write per run).
      // If this run sent none, the previous ones are kept.
      snapshot.indicators = parseIndicators(body.snapshot?.indicatorsHtml, body.snapshot?.indicatorsAt) ?? old?.indicators ?? null;
      if (shouldWriteSnapshot(previous, snapshot, now())) await env.DATA.put(KV_SNAPSHOT, JSON.stringify({ snapshot, receivedAt: now() }));
      const [journal, refuels] = await Promise.all([env.DATA.get(KV_JOURNAL, 'json'), env.DATA.get(KV_REFUELS, 'json')]);
      return send(env, 200, {
        ok: true,
        needJournal: cleanHash(body.journalHash) !== null && body.journalHash !== journal?.hash,
        needRefuels: cleanHash(body.refuelsHash) !== null && body.refuelsHash !== refuels?.hash
      });
    }
    const isJournal = url.pathname === '/api/ingest/journal';
    const rows = isJournal ? cleanJournal(body.rows) : cleanRefuels(body.rows);
    const hash = cleanHash(body.hash);
    if (!rows || !hash) return send(env, 400, { error: 'Некоректні рядки або hash.' });
    await env.DATA.put(isJournal ? KV_JOURNAL : KV_REFUELS, JSON.stringify({ hash, rows, receivedAt: now() }));
    return send(env, 200, { ok: true, count: rows.length });
  }

  // ---- Generator report from the pushed journal and refuels ----
  // /api/generator-report?from=&to=  (default: the last 7 days; at most 31 days). /api/generator is the same answer.
  async function report(env, url) {
    const today = dayAt(now());
    const to = url.searchParams.get('to') || today;
    const from = url.searchParams.get('from') || shiftDay(to, -6);
    if (!validDay(from) || !validDay(to) || from > to) return send(env, 400, { error: 'Вкажіть період: from і to у форматі РРРР-ММ-ДД.' });
    if (to > today) return send(env, 400, { error: 'Дата "to" не може бути в майбутньому.' });
    const windowDays = dayList(from, to);
    if (windowDays.length > GENERATOR_MAX_DAYS) return send(env, 400, { error: 'Період не може бути більшим за ' + GENERATOR_MAX_DAYS + ' днів.' });

    const [journal, refuelBlock, saved] = await Promise.all([
      env.DATA.get(KV_JOURNAL, 'json'), env.DATA.get(KV_REFUELS, 'json'), env.DATA.get(KV_SNAPSHOT, 'json')]);
    if (!journal) return send(env, 503, { error: 'Журнал ще не надходив.' });
    const refuels = refuelBlock?.rows ?? [];
    const genStatus = saved?.snapshot?.genStatus ?? null;
    const all = sessionsFromJournal(journal.rows, { now: now(), genStatus, genPeak: saved?.snapshot?.genPeak ?? null });
    const firstDay = journal.rows.length ? dayAt(Math.min(...journal.rows.map(r => r.at))) : null;

    const missingDays = [];
    const days = [];
    for (const date of windowDays) {
      if (firstDay === null || date < firstDay) { missingDays.push({ date, reason: 'no-data', refuels: refuels.filter(r => dayAt(r.at) === date).map(publicRefuel) }); continue; }
      days.push({ ...summarizeDayFromSessions(date, all, now()),
        refuels: refuels.filter(r => dayAt(r.at) === date).map(publicRefuel) });
    }
    const sessions = all.filter(s => dayAt(s.start) >= from && dayAt(s.start) <= to);

    return send(env, 200, {
      from, to, timezone: 'Europe/Kyiv',
      totalMinutes: days.reduce((sum, d) => sum + d.minutes, 0),
      totalStarts: sessions.length,
      days, sessions,
      indicators: saved?.snapshot?.indicators ?? null,
      refuels: refuels.filter(r => dayAt(r.at) >= from && dayAt(r.at) <= to).map(publicRefuel),
      refuelsConfigured: refuelBlock !== null, refuelsError: null,
      missingDays
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
    if (['/api/ingest', '/api/ingest/journal', '/api/ingest/refuels'].includes(url.pathname)) {
      if (request.method !== 'POST') return send(env, 405, { error: 'Дозволено лише POST.' });
      return ingest(request, env, url);
    }
    if (request.method !== 'GET') return send(env, 405, { error: 'Дозволено лише GET.' });
    if (url.pathname === '/' || url.pathname === '/health') return send(env, 200, { ok: true });
    if (!['/api/status', '/api/generator', '/api/generator-report'].includes(url.pathname)) return send(env, 404, { error: 'Не знайдено.' });
    if (!env.DATA) return send(env, 500, { error: 'KV не налаштований.' });

    if (url.pathname === '/api/status') {
      const saved = await env.DATA.get(KV_SNAPSHOT, 'json');
      const data = saved ? snapshotToStatus(saved.snapshot, saved.receivedAt, now()) : null;
      if (!data) return send(env, 503, { error: 'Дані ще не надходили.' });
      // The last generator run (start / stop) comes from the journal.
      const journal = await env.DATA.get(KV_JOURNAL, 'json');
      const last = Array.isArray(journal?.rows) ? sessionsFromJournal(journal.rows, { now: now(), genStatus: saved.snapshot.genStatus }).pop() : null;
      data.generator.startedAt = last?.start ?? null;
      data.generator.stoppedAt = last?.end ?? null;
      return send(env, 200, publicStatus(data));
    }
    const denied = checkPassword(request, env);
    if (denied) return denied;
    return report(env, url);
  };
}

const handle = createHandler();
export default { fetch: (request, env) => handle(request, env) };
