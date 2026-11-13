import test from 'node:test';
import assert from 'node:assert/strict';
import { publicStatus } from '../lib/public-status.mjs';
import { DeyeClient } from '../lib/deye.mjs';

test('public status permits only numeric timings', () => {
  const result = publicStatus({diagnostics:{requestStartedAt:100, latestReceivedAt:200,
    completedAt:300, stationUpdatedAt:50, fileCreatedAt:400, runId:123, runAttempt:2,
    password:'private', response:'private', token:'private'}});
  assert.equal(result.diagnostics.completedAt, 300);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(publicStatus({diagnostics:{completedAt:'secret'}}).diagnostics.completedAt, null);
});

test('Deye diagnostics surround latest and history requests without exposing readings', async () => {
  const client = new DeyeClient({stationId:'1'});
  const time = Date.now();
  client.list = async () => [{deviceType:'INVERTER',deviceSn:'private-sn'}];
  client.request = async endpoint => endpoint === 'station/latest'
    ? {lastUpdateTime:time}
    : {deviceDataList:[{deviceSn:'private-sn',collectionTime:time,dataList:[]}]};
  client.history = async () => ({appeared:null,disappeared:null});
  const data = await client.dashboard();
  assert.ok(data.diagnostics.requestStartedAt <= data.diagnostics.latestReceivedAt);
  assert.ok(data.diagnostics.latestReceivedAt <= data.diagnostics.completedAt);
  assert.equal(data.diagnostics.stationUpdatedAt, time);
  assert.ok(!JSON.stringify(publicStatus(data)).includes('private-sn'));
});
