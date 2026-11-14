import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../worker/index.mjs';

const snapshot = { measuredAt: 1000, gridStatus: 0 };
const env = { DATA: { get: async () => ({ receivedAt: 1000, snapshot }), put: async () => {} } };
const get = (handle, path = '/api/status', e = env) => handle(new Request('https://w.example' + path), e);

test('status comes from the stored snapshot; nothing else leaks', async () => {
  const handle = createHandler({ now: () => 2000 });
  const data = await (await get(handle)).json();
  assert.equal(data.grid, 'off');
  assert.equal(data.stale, false);
});

test('status is stale after 30 minutes and unavailable without data', async () => {
  const handle = createHandler({ now: () => 1000 + 31 * 60000 });
  assert.equal((await (await get(handle)).json()).stale, true);
  const empty = { DATA: { get: async () => null, put: async () => {} } };
  assert.equal((await get(handle, '/api/status', empty)).status, 503);
});

test('worker allows only GET (POST only for ingest) and sends CORS headers', async () => {
  const handle = createHandler({ now: () => 2000 });
  assert.equal((await handle(new Request('https://w.example/api/status', { method: 'POST' }), env)).status, 405);
  assert.equal((await handle(new Request('https://w.example/api/ingest'), env)).status, 405);
  assert.equal((await get(handle)).headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await get(handle, '/api/status', { ...env, ALLOWED_ORIGIN: 'https://x.example' })).headers.get('Access-Control-Allow-Origin'), 'https://x.example');
  assert.equal((await get(handle, '/other')).status, 404);
});
