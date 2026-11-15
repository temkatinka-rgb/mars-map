import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, createServer } from './server.mjs';

const start = Date.parse('2026-11-15T00:00:00Z');
function packet() {
  return {
    postId: 'urtuu-01', messageId: 'msg-01', observedAt: new Date(start).toISOString(), simulated: true,
    position: { frame: 'demo-local-meters', xM: 0, yM: 0 },
    layers: { weather: { observedAt: new Date(start).toISOString(), sensorId: 'wx', airTemperatureC: -40, pressurePa: 600, windSpeedMps: 10, windDirectionDeg: 90 } },
    power: { solarOutputW: 200, stationLoadW: 50, batteries: [
      { id: 'battery-01', compatibility: 'rover-v1', capacityWh: 2000, stateOfChargePct: 90, status: 'available' },
    ] },
  };
}

test('unknown sensors remain unknown; only fresh compatible available batteries qualify', () => {
  let now = start;
  const store = createStore({ clock: () => now });
  store.ingest(packet());
  assert.equal(store.list()[0].layers.radiation.status, 'unknown');
  assert.equal(store.list()[0].power.netGenerationW, 150);
  assert.equal(store.resupply('rover-v1')[0].battery.nominalStoredWh, 1800);
  assert.equal(store.resupply('wrong-pack').length, 0);
  assert.equal(store.resupply('rover-v1', 95).length, 0);
  now += 121000;
  assert.equal(store.list()[0].layers.weather.status, 'stale');
  assert.equal(store.resupply('rover-v1').length, 0);
});

test('duplicates are idempotent and delayed/conflicting snapshots are rejected', () => {
  const store = createStore({ clock: () => start });
  const p = packet();
  store.ingest(p);
  assert.equal(store.ingest(p).duplicate, true);
  assert.throws(() => store.ingest({ ...p, simulated: false }), /reused/);
  assert.throws(() => store.ingest({ ...p, messageId: 'msg-02' }), /Out-of-order/);
  assert.equal(store.list().length, 1);
});

test('sensor timestamps stay stale even in a new post report; no invented availability', () => {
  const store = createStore({ clock: () => start + 300000 });
  const p = packet();
  p.observedAt = new Date(start + 300000).toISOString();
  p.power.batteries[0].status = 'charging';
  store.ingest(p);
  assert.equal(store.list()[0].layers.weather.status, 'stale');
  assert.equal(store.list()[0].power.status, 'fresh');
  assert.equal(store.resupply('rover-v1').length, 0);
});

test('invalid coordinates, units/ranges, timestamps and image schemes are rejected', () => {
  const store = createStore({ clock: () => start });
  for (const mutate of [
    p => { p.position.frame = 'Earth-WGS84'; },
    p => { p.power.batteries[0].stateOfChargePct = 101; },
    p => { p.observedAt = 'tomorrow'; },
    p => { p.layers.weather.windSpeedMps = '10'; },
    p => { p.layers.optical = { observedAt: p.observedAt, sensorId: 'cam', imageUrl: 'file:///secret' }; },
    p => { p.layers.radiation = { observedAt: p.observedAt, sensorId: 'rad', absorbedDoseRateMicroGyPerHour: -1 }; },
  ]) {
    const p = packet(); mutate(p);
    assert.throws(() => store.ingest(p));
  }
  assert.equal(store.list().length, 0);
});

test('latest snapshots survive a restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'urtuu-test-'));
  try {
    const options = { file: join(directory, 'posts.json'), clock: () => start };
    createStore(options).ingest(packet());
    assert.equal(createStore(options).list()[0].postId, 'urtuu-01');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP ingest, authentication, layers, resupply, CORS and malformed JSON', async () => {
  const server = createServer(createStore({ clock: () => start }), { token: 'test-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (body, token = 'test-token') => fetch(`${base}/api/posts/telemetry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body,
    });
    assert.equal((await post(JSON.stringify(packet()), 'wrong')).status, 401);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify(packet()))).status, 200);
    const layers = await fetch(`${base}/api/layers`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(layers.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal((await layers.json()).layers.weather[0].status, 'fresh');
    const candidates = await (await fetch(`${base}/api/resupply?compatibility=rover-v1`)).json();
    assert.equal(candidates.candidates.length, 1);
    assert.equal((await fetch(`${base}/api/resupply`)).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
