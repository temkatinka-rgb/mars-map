import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpticalStore, MAX_IMAGE_BYTES } from './optical.mjs';
import { createServer, createStore } from './server.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEioAAAAASUVORK5CYII=';
const now = Date.parse('2026-11-15T10:00:00Z');
function drone(overrides = {}) {
  return { imageId: 'image-1', sourceType: 'drone', sourceId: 'drone-01', missionId: 'demo-mission',
    capturedAt: new Date(now).toISOString(), simulated: true,
    position: { frame: 'demo-local-meters', xM: 10, yM: 20 }, caption: 'Synthetic transfer fixture',
    mimeType: 'image/png', imageBase64: png, ...overrides };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'urtuu-optical-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('uploaded bytes and metadata survive restart; retries cannot overwrite an image', t => {
  const directory = fixture(t);
  const store = createOpticalStore({ directory, clock: () => now });
  const first = store.ingest(drone());
  assert.equal(first.duplicate, false);
  assert.equal(store.ingest(drone()).duplicate, true);
  assert.throws(() => store.ingest(drone({ caption: 'Changed' })), /different content/);
  const reopened = createOpticalStore({ directory, clock: () => now });
  assert.equal(reopened.latest().imageId, 'image-1');
  assert.equal(reopened.latest().status, 'fresh');
  const file = first.image.imageUrl.split('/').pop();
  assert.deepEqual(reopened.readImage(file).bytes, Buffer.from(png, 'base64'));
});

test('late captures never replace latest; filters separate drones, missions and satellite references', t => {
  const store = createOpticalStore({ directory: fixture(t), clock: () => now });
  store.ingest(drone());
  store.ingest(drone({ imageId: 'older', capturedAt: new Date(now - 180000).toISOString() }));
  store.ingest(drone({ imageId: 'other-drone', sourceId: 'drone-02' }));
  store.ingest(drone({ imageId: 'other-mission', missionId: 'mission-02' }));
  store.ingest({ imageId: 'sat-1', sourceType: 'satellite', sourceId: 'orbiter', missionId: 'demo-mission',
    capturedAt: new Date(now).toISOString(), simulated: false, caption: 'Test URL, never fetched', position: null,
    imageUrl: 'https://example.org/reference.jpg', sourceUrl: 'https://example.org/source' });
  const filtered = store.list({ sourceType: 'drone', sourceId: 'drone-01', missionId: 'demo-mission' });
  assert.deepEqual(filtered.map(i => i.imageId), ['image-1', 'older']);
  assert.equal(filtered[1].status, 'stale');
  assert.equal(store.latest({ sourceType: 'satellite' }).status, 'reference');
  assert.equal(store.latest({ sourceId: 'absent' }), null);
  assert.equal(store.list({}, 1).length, 1);
  assert.throws(() => store.list({}, 101));
});

test('malformed image data, unsafe URLs, oversize photos and invalid metadata are rejected', t => {
  const store = createOpticalStore({ directory: fixture(t), clock: () => now });
  for (const overrides of [
    { imageBase64: 'not-base64' }, { imageBase64: Buffer.from('not an image').toString('base64') },
    { mimeType: 'image/jpeg' }, { imageId: '../escape' }, { sourceType: 'unknown' },
    { position: null }, { capturedAt: new Date(now + 120000).toISOString() },
    { simulated: undefined }, { sourceUrl: 'file:///private' },
    { imageBase64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') },
  ]) assert.throws(() => store.ingest(drone(overrides)));
  assert.throws(() => store.readImage('../../outside'));
  assert.equal(store.list().length, 0);
});

test('HTTP image upload to frontend download, source-aware layers and error responses', async t => {
  const optical = createOpticalStore({ directory: fixture(t), clock: () => now });
  const server = createServer(createStore(), { optical, token: 'test-secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (body, token = 'test-secret', type = 'application/json') => fetch(`${base}/api/optical/images`, {
    method: 'POST', headers: { 'Content-Type': type, Authorization: `Bearer ${token}` }, body,
  });
  try {
    assert.equal((await (await fetch(`${base}/api/optical/latest?sourceType=drone`)).json()).image, null);
    assert.equal((await send(JSON.stringify(drone()), 'bad')).status, 401);
    assert.equal((await send('{}', 'test-secret', 'text/plain')).status, 415);
    assert.equal((await send('{')).status, 400);
    assert.equal((await send('x'.repeat(6 * 1024 * 1024 + 1))).status, 413);
    const upload = await send(JSON.stringify(drone()));
    assert.equal(upload.status, 201);
    const record = (await upload.json()).image;
    const photo = await fetch(new URL(record.imageUrl, base));
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.from(png, 'base64'));
    assert.equal((await send(JSON.stringify(drone()))).status, 200);
    assert.equal((await send(JSON.stringify(drone({ caption: 'conflict' })))).status, 409);
    const latest = await (await fetch(`${base}/api/optical/latest?sourceType=drone&sourceId=drone-01&missionId=demo-mission`)).json();
    assert.equal(latest.image.imageUrl, record.imageUrl);
    const layers = await (await fetch(`${base}/api/layers?missionId=demo-mission`)).json();
    assert.equal(layers.layers.optical[0].sourceType, 'drone');
    assert.equal((await fetch(`${base}/api/images/missing.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/optical/images?limit=garbage`)).status, 400);
    assert.equal((await fetch(`${base}/api/optical/latest?sourceType=invalid`)).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
