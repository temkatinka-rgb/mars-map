import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createServer, createStore } from './server.mjs';
import { createOpticalStore } from './optical.mjs';
import { createMarsClient } from './frontend-client.js';

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('frontend client connects and resolves uploaded images against backend; mission filter works', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'urtuu-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const optical = createOpticalStore({ directory });
  const baseUrl = await serve(t, createServer(createStore(), { optical }));
  const client = createMarsClient({ baseUrl });
  assert.equal((await client.checkConnection()).status, 'ok');
  assert.equal((await client.getDashboard()).latestDroneImage, null);
  optical.ingest({ imageId: 'pic', missionId: 'demo-mission', sourceType: 'drone', sourceId: 'drone-01',
    capturedAt: new Date().toISOString(), simulated: true, caption: 'Test fixture',
    position: { frame: 'demo-local-meters', xM: 1, yM: 2 }, mimeType: 'image/png',
    imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEioAAAAASUVORK5CYII=' });
  const dashboard = await client.getDashboard();
  assert.deepEqual(Object.keys(dashboard.layers), ['weather', 'optical', 'thermal', 'radiation']);
  assert.ok(dashboard.latestDroneImage.imageUrl.startsWith(`${baseUrl}/api/images/`));
  assert.equal((await fetch(dashboard.latestDroneImage.imageUrl)).status, 200);
  assert.equal((await client.getLatestDroneImage()).imageId, 'pic');
  assert.equal((await client.getLayers()).layers.optical[0].imageUrl, dashboard.latestDroneImage.imageUrl);
  assert.deepEqual((await client.getPosts()).posts, []);
  assert.deepEqual((await client.getResupply('demo-pack')).candidates, []);
  assert.equal((await createMarsClient({ baseUrl, missionId: 'other-mission' }).getDashboard()).latestDroneImage, null);
  await assert.rejects(client.getResupply('demo-pack', 101), error => error.status === 400);
});

test('common development origins work; other origins require configuration', async t => {
  const baseUrl = await serve(t, createServer(createStore()));
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:5500']) {
    const response = await fetch(`${baseUrl}/api/dashboard`, { headers: { Origin: origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.status, 200);
    const preflight = await fetch(`${baseUrl}/api/dashboard`, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(preflight.status, 200);
  }
  const blocked = await fetch(`${baseUrl}/api/dashboard`, { headers: { Origin: 'https://unlisted.example' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  const customBase = await serve(t, createServer(createStore(), { origins: ['http://192.168.1.20:5173'] }));
  const custom = await fetch(`${customBase}/api/dashboard`, { headers: { Origin: 'http://192.168.1.20:5173' } });
  assert.equal(custom.headers.get('access-control-allow-origin'), 'http://192.168.1.20:5173');
});

test('watcher recovers after backend error and stops cleanly', { timeout: 5000 }, async t => {
  let requests = 0; let errors = 0; let received = 0;
  const baseUrl = await serve(t, http.createServer((req, res) => {
    requests++;
    res.writeHead(requests === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(requests === 1 ? { error: 'Temporarily offline' } : { latestDroneImage: null }));
  }));
  const client = createMarsClient({ baseUrl });
  await new Promise((resolve, reject) => {
    const stop = client.watchDashboard({ intervalMs: 100,
      onError(error) { errors++; if (error.status !== 503) { stop(); reject(error); } },
      onData(data) { received++; assert.equal(data.latestDroneImage, null); stop(); resolve(); },
    });
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(errors, 1); assert.equal(received, 1); assert.equal(requests, 2);
});

test('requests time out; stopping a watcher cancels pending delivery', { timeout: 5000 }, async t => {
  const baseUrl = await serve(t, http.createServer(() => {}));
  const client = createMarsClient({ baseUrl, timeoutMs: 100 });
  await assert.rejects(client.checkConnection(), /timed out/);
  let deliveries = 0;
  const stop = client.watchDashboard({ onData: () => deliveries++, onError: () => deliveries++ });
  stop();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(deliveries, 0);
});
