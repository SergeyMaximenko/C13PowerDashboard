import test from 'node:test';
import assert from 'node:assert/strict';
import { DeyeClient } from '../lib/deye.mjs';
const settings = { appId: 'id', login: 'test@example.com', password: 'private-password', appSecret: 'private-secret' };
test('auth hashing, shared login and Bearer handling', async () => {
  let logins = 0;
  const client = new DeyeClient(settings, async (url, options) => {
    if (url.includes('account/token')) {
      logins++; const body = JSON.parse(options.body);
      assert.match(body.password, /^[a-f0-9]{64}$/);
      assert.equal(body.email, settings.login);
      return Response.json({ success: true, accessToken: 'Bearer token', expiresIn: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer token');
    return Response.json({ success: true, stationList: [{ id: 1, name: 'Station' }], total: 1 });
  });
  await Promise.all([client.stations(), client.stations()]);
  assert.equal(logins, 1);
});
test('history supplies both dates, derives midpoint and reloads only what can have changed', async () => {
  const client = new DeyeClient(settings);
  const calls = [];
  client.request = async (endpoint, body) => {
    calls.push({ endpoint, body });
    assert.equal(body.startAt, body.endAt); assert.equal(body.granularity, 1);
    const items = v => [{ key: 'GridVoltageL1L2', value: v }, { key: 'GridFrequency', value: v ? 50 : 0 }];
    if (body.startAt === '2026-10-20') return { dataList: [] };
    return { dataList: [
      { time: '12:14:02', itemList: items(230) },
      { time: '12:19:08', itemList: items(0) }
    ] };
  };
  const result = await client.history('sn', Date.parse('2026-10-21T15:00:00+03:00'), false);
  assert.equal(result.disappeared.at, Date.parse('2026-10-21T12:16:35+03:00'));
  assert.equal(calls.length, 2);
  // The same inverter measurement again: nothing is downloaded.
  await client.history('sn', Date.parse('2026-10-21T15:00:00+03:00'), false);
  assert.equal(calls.length, 2);
  // A newer measurement on the same day: only today is reloaded, the finished day 20.10 stays cached.
  await client.history('sn', Date.parse('2026-10-21T15:05:00+03:00'), false);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.startAt, '2026-10-21');
  // A measurement on the next day: yesterday's partial data is downloaded again once, because it was not finished before.
  await client.history('sn', Date.parse('2026-10-22T00:05:00+03:00'), false);
  assert.equal(calls.length, 5);
});
test('DNS and upstream secrets never leak', async () => {
  const client = new DeyeClient(settings, async () => { throw Object.assign(new Error(), { cause: { code: 'ENOTFOUND' } }); });
  await assert.rejects(client.stations(), /DNS/);
  assert.equal(client.safeMessage('private-password private-secret'), '[приховано] [приховано]');
});
