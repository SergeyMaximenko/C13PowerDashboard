import { createHash } from 'node:crypto';
import { dayAt, previousDay, parseTime, points, threePhase, gridState, transitions, summarize } from './domain.mjs';

const BASE = 'https://eu1-developer.deyecloud.com/v1.0/';
const DEVICES_TTL_MS = 24 * 60 * 60 * 1000;
export class DeyeClient {
  constructor(settings, fetcher = (...args) => fetch(...args), options = {}) {
    this.settings = settings;
    this.fetcher = fetcher;
    // `shared` is plain data (token, history) that a Worker keeps between requests.
    // Promises are never shared across requests: Cloudflare hangs a request that waits for another request's promise.
    this.shared = options.shared || null;
    this.token = this.shared?.token ?? null;
    this.expiresAt = this.shared?.expiresAt ?? 0;
    this.loginPending = null;
    this.historyCache = this.shared?.historyCache ?? new Map();
  }
  safeMessage(message) {
    let text = String(message ?? '').replace(/[\r\n]/g, ' ').slice(0, 500);
    for (const secret of [this.settings.password, this.settings.appSecret, this.token]) {
      if (secret) text = text.split(secret).join('[приховано]');
    }
    return text;
  }
  async request(endpoint, body, authenticated = true, retry = true) {
    if (authenticated) await this.login();
    let response;
    try {
      response = await this.fetcher(BASE + endpoint, {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          ...(authenticated ? { Authorization: 'Bearer ' + this.token } : {})
        }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000)
      });
    } catch (error) {
      const reason = error.cause?.code;
      if (reason === 'ENOTFOUND' || reason === 'EAI_AGAIN')
        throw new Error('DNS: не вдалося знайти сервер Deye. Перевірте інтернет і DNS.');
      if (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new Error('Deye не відповів за 25 секунд. Спробуйте оновити пізніше.');
      throw new Error('Не вдалося підключитися до Deye Cloud. Перевірте інтернет.');
    }
    if (response.status === 401 && authenticated && retry) {
      this.token = null;
      if (this.shared) this.shared.token = null;
      return this.request(endpoint, body, authenticated, false);
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('Deye повернув неочікувану відповідь (HTTP ' + response.status + ').'); }
    if (!response.ok || data.success !== true)
      throw new Error('Deye: ' + this.safeMessage(data.msg || data.message || 'помилка запиту') +
        ' (HTTP ' + response.status + ', код ' + this.safeMessage(data.code ?? '—') + ').');
    return data;
  }
  async login() {
    if (this.token && this.expiresAt > Date.now() + 60000) return;
    if (this.loginPending) return this.loginPending;
    this.loginPending = (async () => {
      const s = this.settings;
      const body = { appSecret: s.appSecret, password: createHash('sha256').update(s.password).digest('hex') };
      body[s.login.includes('@') ? 'email' : 'username'] = s.login;
      const data = await this.request('account/token?appId=' + encodeURIComponent(s.appId), body, false);
      if (typeof data.accessToken !== 'string' || !data.accessToken.trim()) throw new Error('Deye не повернув токен доступу.');
      this.token = data.accessToken.replace(/^Bearer\s+/i, '').trim();
      this.expiresAt = Date.now() + (Number(data.expiresIn) || 3600) * 1000;
      if (this.shared) { this.shared.token = this.token; this.shared.expiresAt = this.expiresAt; }
    })();
    try { await this.loginPending; } finally { this.loginPending = null; }
  }
  async list(endpoint, key, extra = {}) {
    const result = [];
    const seen = new Set();
    for (let page = 1; page <= 100; page++) {
      const data = await this.request(endpoint, { ...extra, page, size: 100 });
      if (!Array.isArray(data[key])) throw new Error('Deye: відсутній список ' + key + '.');
      const rows = data[key];
      let added = 0;
      for (const row of rows) {
        const identity = String(row.id ?? row.deviceSn ?? JSON.stringify(row));
        if (seen.has(identity)) continue;
        seen.add(identity); result.push(row); added++;
      }
      if (!rows.length || !added || (Number.isFinite(Number(data.total)) && result.length >= Number(data.total)) || rows.length < 100)
        return result;
    }
    throw new Error('Deye повернув забагато сторінок.');
  }
  async stations() {
    const rows = await this.list('station/list', 'stationList');
    return rows.map(s => ({ id: String(s.id), name: String(s.name || s.id) }));
  }
  // Downloads one calendar day of grid measurements (the heavy part: several pages of JSON).
  async historyDay(sn, date, measurePoints, three) {
    const samples = [];
    let unparsed = 0;
    const seen = new Set();
    for (let page = 1; page <= 16; page++) {
      const data = await this.request('device/history?page=' + page + '&size=100', {
        deviceSn: sn, granularity: 1, startAt: date, endAt: date, measurePoints
      });
      if (!Array.isArray(data.dataList)) throw new Error('Deye не повернув список історичних показників.');
      let added = 0;
      for (const row of data.dataList) {
        const id = JSON.stringify(row);
        if (seen.has(id)) continue;
        seen.add(id); added++;
        const time = parseTime(row.collectionTime ?? row.time, date);
        if (time === null) { unparsed++; continue; }
        if (dayAt(time) !== date) continue;
        samples.push({ time, state: gridState(points(row.itemList), three) });
      }
      if (data.dataList.length < 100 || !added) break;
      if (page === 16) throw new Error('Історія неповна: перевищена кількість сторінок.');
    }
    return { samples, unparsed };
  }
  // History is downloaded only when it can have changed:
  //  - today's samples: only when a newer inverter measurement has appeared (they arrive about every 5 minutes);
  //  - a finished earlier day: once, it never changes again.
  async history(sn, timestamp, three) {
    const day = dayAt(timestamp);
    const measurePoints = three ? ['GridVoltageL1', 'GridVoltageL2', 'GridVoltageL3', 'GridFrequency']
      : ['GridVoltageL1L2', 'GridFrequency'];
    const samples = [];
    for (const date of [previousDay(day), day]) {
      const key = sn + '/' + three + '/' + date;
      const cached = this.historyCache.get(key);
      if (cached && (date === day ? cached.measuredAt === timestamp : cached.complete)) {
        samples.push(...cached.samples);
        continue;
      }
      const loaded = await this.historyDay(sn, date, measurePoints, three);
      if (!loaded.samples.length && loaded.unparsed) throw new Error('Не вдалося визначити час історичних вимірювань Deye.');
      this.historyCache.set(key, { samples: loaded.samples, measuredAt: timestamp, complete: dayAt(timestamp) !== date });
      if (this.historyCache.size > 12) this.historyCache.delete(this.historyCache.keys().next().value);
      samples.push(...loaded.samples);
    }
    return transitions(samples.filter(s => s.time <= timestamp));
  }
  async dashboard() {
    const requestStartedAt = Date.now();
    if (!this.settings.stationId) throw new Error('Спочатку виберіть станцію.');
    const station = { id: this.settings.stationId, name: this.settings.stationName || 'Чавдар 13' };
    const stationId = Number(station.id);
    if (!Number.isSafeInteger(stationId)) throw new Error('Некоректний ID станції.');
    // The device list is static: keep it for a day (plain data only, no shared promises).
    const cached = this.shared?.devices;
    const fresh = cached && cached.stationId === stationId && Date.now() - cached.at < DEVICES_TTL_MS;
    const [latest, devices] = await Promise.all([
      this.request('station/latest', { stationId }),
      fresh ? cached.items : this.list('station/device', 'deviceListItems', { stationIds: [stationId] })
    ]);
    if (!fresh && this.shared && devices.some(d => d.deviceType === 'INVERTER'))
      this.shared.devices = { stationId, at: Date.now(), items: devices };
    const inverters = devices.filter(d => d.deviceType === 'INVERTER');
    if (!inverters.length) throw new Error('Для вибраної станції API не повернув інверторів.');
    const readings = [];
    for (let i = 0; i < inverters.length; i += 10) {
      const data = await this.request('device/latest', { deviceList: inverters.slice(i, i + 10).map(d => d.deviceSn) });
      if (!Array.isArray(data.deviceDataList)) throw new Error('Deye не повернув показники інверторів.');
      readings.push(...data.deviceDataList);
    }
    // Missing inverters must not silently look like healthy complete station data.
    const complete = inverters.map(d => readings.find(r => r.deviceSn === d.deviceSn) ?? { deviceSn: d.deviceSn, dataList: [] });
    const result = summarize(station, latest, complete);
    result.diagnostics = { requestStartedAt, latestReceivedAt: Date.now(), stationUpdatedAt: parseTime(latest.lastUpdateTime) };
    result.events = { appeared: null, disappeared: null };
    result.historyAvailable = false;
    if (complete.length === 1 && result.collectedAt !== null) {
      try {
        result.events = await this.history(complete[0].deviceSn, result.collectedAt, threePhase(points(complete[0].dataList)));
        result.historyAvailable = true;
      } catch (error) {
        result.historyError = this.safeMessage(error.message);
      }
    }
    result.diagnostics.completedAt = Date.now();
    return result;
  }
}
