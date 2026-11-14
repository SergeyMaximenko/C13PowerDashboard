import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../worker/index.mjs';

const at = text => Date.parse(text + '+02:00');
const kv = data => ({ get: async key => data[key] ?? null, put: async () => {} });
const base = { DATA: kv({
  'ingest:journal': { hash: 'j', rows: [{ object: 'Генератор', at: at('2026-11-08T10:00:00'), onOff: 1 }, { object: 'Генератор', at: at('2026-11-08T10:05:00'), onOff: 0 }] },
  'ingest:snapshot': { receivedAt: at('2026-11-09T11:59:00'), snapshot: { measuredAt: at('2026-11-09T11:58:00'), gridStatus: 1 } }
}) };
const make = () => createHandler({ now: () => at('2026-11-09T12:00:00') });
const ask = (handle, path, password, ip = '1.1.1.1', env = { ...base, REPORT_PASSWORD: '13' }) => handle(new Request('https://x.test' + path, {
  headers: { 'CF-Connecting-IP': ip, ...(password === undefined ? {} : { 'X-Report-Password': encodeURIComponent(password) }) } }), env);

test('report endpoints need the password, the main status stays open', async () => {
  const handle = make();
  for (const path of ['/api/generator-report?from=2026-11-08&to=2026-11-09', '/api/generator?from=2026-11-08&to=2026-11-09']) {
    const missing = await ask(handle, path);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, 'Потрібен пароль.');
    const wrong = await ask(handle, path, '14');
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, 'Невірний пароль.');
    assert.equal((await ask(handle, path, '130')).status, 401);
    assert.equal((await ask(handle, path, '')).status, 401);
    assert.equal((await ask(handle, path, '13')).status, 200);
  }
  assert.equal((await ask(handle, '/api/status')).status, 200);
});

test('password with non-Latin letters and symbols works (URL-encoded in the header)', async () => {
  const handle = make();
  const env = { ...base, REPORT_PASSWORD: 'Пароль №13 ✓' };
  assert.equal((await ask(handle, '/api/generator-report?from=2026-11-09&to=2026-11-09', 'Пароль №13 ✓', '2.2.2.2', env)).status, 200);
  assert.equal((await ask(handle, '/api/generator-report?from=2026-11-09&to=2026-11-09', 'Пароль', '2.2.2.2', env)).status, 401);
});

test('without the secret the report stays open (backward compatible); the browser may send the password header (CORS)', async () => {
  const handle = make();
  assert.equal((await ask(handle, '/api/generator-report?from=2026-11-09&to=2026-11-09', undefined, '3.3.3.3', base)).status, 200);
  const preflight = await handle(new Request('https://x.test/api/generator-report', { method: 'OPTIONS' }), base);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Report-Password/);
});

test('too many wrong attempts from one address are blocked for 10 minutes, other addresses are not affected', async () => {
  let clock = at('2026-11-09T12:00:00');
  const handle = createHandler({ now: () => clock });
  const path = '/api/generator-report?from=2026-11-09&to=2026-11-09';
  for (let i = 0; i < 10; i++) assert.equal((await ask(handle, path, 'x' + i, '4.4.4.4')).status, 401);
  assert.equal((await ask(handle, path, '13', '4.4.4.4')).status, 429); // even the right password waits
  assert.equal((await ask(handle, path, '13', '5.5.5.5')).status, 200);
  clock += 11 * 60000;
  assert.equal((await ask(handle, path, '13', '4.4.4.4')).status, 200);
});

test('the password is never put into an answer', async () => {
  const handle = make();
  const env = { ...base, REPORT_PASSWORD: 'SECRET-PASS' };
  const path = '/api/generator-report?from=2026-11-09&to=2026-11-09';
  assert.ok(!(await (await ask(handle, path, 'SECRET-PASS', '6.6.6.6', env)).text()).includes('SECRET-PASS'));
  assert.ok(!(await (await ask(handle, path, 'SECRET-PASS-WRONG', '6.6.6.6', env)).text()).includes('SECRET-PASS'));
});
