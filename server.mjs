import http from 'node:http';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpticalStore, readJson } from './optical.mjs';

export const LAYERS = ['weather', 'optical', 'thermal', 'radiation'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) fail(`Invalid ${label}`);
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail('Invalid identifier');
}
function timestamp(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('Timestamp must be UTC ISO 8601');
  if (Date.parse(value) > now + 60000) fail('Observation is more than 60 seconds in the future');
}
function fields(value, ranges) {
  for (const [key, range] of Object.entries(ranges)) number(value[key], ...range, key);
}
function validate(packet, now) {
  if (!object(packet)) fail('Expected an object');
  identifier(packet.postId);
  identifier(packet.messageId);
  timestamp(packet.observedAt, now);
  if (typeof packet.simulated !== 'boolean') fail('simulated must be explicit');
  if (!object(packet.position) || packet.position.frame !== 'demo-local-meters') fail('Expected demo-local-meters coordinates');
  fields(packet.position, { xM: [-1e7, 1e7], yM: [-1e7, 1e7] });
  if (!object(packet.layers)) fail('layers must be an object');
  for (const key of Object.keys(packet.layers)) if (!LAYERS.includes(key)) fail(`Unknown layer: ${key}`);
  for (const layer of LAYERS) {
    const reading = packet.layers[layer];
    if (reading == null) continue;
    if (!object(reading)) fail(`Invalid ${layer} reading`);
    timestamp(reading.observedAt, now);
    if (Date.parse(reading.observedAt) > Date.parse(packet.observedAt)) fail('Reading cannot be newer than its packet');
    if (typeof reading.sensorId !== 'string' || !reading.sensorId.trim() || reading.sensorId.length > 100) fail('sensorId required');
    if (layer === 'weather') fields(reading, { airTemperatureC: [-150, 60], pressurePa: [0, 2000], windSpeedMps: [0, 200], windDirectionDeg: [0, 359.999] });
    if (layer === 'thermal') fields(reading, { surfaceTemperatureC: [-200, 150] });
    if (layer === 'radiation') fields(reading, { absorbedDoseRateMicroGyPerHour: [0, 1e9] });
    if (layer === 'optical') {
      let url;
      try { url = new URL(reading.imageUrl); } catch { fail('Invalid optical imageUrl'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('Use an HTTP(S) image reference');
    }
  }
  if (!object(packet.power)) fail('power snapshot required');
  fields(packet.power, { solarOutputW: [0, 1e9], stationLoadW: [0, 1e9] });
  if (!Array.isArray(packet.power.batteries) || packet.power.batteries.length > 100) fail('Invalid batteries');
  const ids = new Set();
  for (const battery of packet.power.batteries) {
    if (!object(battery)) fail('Invalid battery');
    identifier(battery.id);
    if (ids.has(battery.id)) fail('Duplicate battery id');
    ids.add(battery.id);
    fields(battery, { capacityWh: [1, 1e9], stateOfChargePct: [0, 100] });
    if (typeof battery.compatibility !== 'string' || !battery.compatibility.trim() || battery.compatibility.length > 80) fail('Battery compatibility required');
    if (!['available', 'charging', 'reserved', 'fault'].includes(battery.status)) fail('Invalid battery status');
  }
}

export function createStore({ file = null, clock = Date.now, staleAfterSeconds = 120 } = {}) {
  let posts = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const freshness = at => Math.max(0, (clock() - Date.parse(at)) / 1000);
  const readingView = reading => reading == null ? { status: 'unknown' } : {
    ...reading, ageSeconds: freshness(reading.observedAt),
    status: freshness(reading.observedAt) > staleAfterSeconds ? 'stale' : 'fresh',
  };
  return {
    ingest(packet) {
      validate(packet, clock());
      const key = `post:${packet.postId}`;
      const previous = posts[key];
      if (previous?.messageId === packet.messageId) {
        if (JSON.stringify(previous.payload) !== JSON.stringify(packet)) fail('messageId reused with changed payload', 409);
        return { accepted: true, duplicate: true };
      }
      if (previous && Date.parse(packet.observedAt) <= Date.parse(previous.payload.observedAt)) fail('Out-of-order or equal-time snapshot', 409);
      const next = { ...posts, [key]: { messageId: packet.messageId, receivedAt: new Date(clock()).toISOString(), payload: structuredClone(packet) } };
      if (file) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
        renameSync(`${file}.tmp`, file);
      }
      posts = next;
      return { accepted: true, duplicate: false };
    },
    list() {
      return Object.values(posts).map(({ payload: p, receivedAt }) => {
        const powerStatus = freshness(p.observedAt) > staleAfterSeconds ? 'stale' : 'fresh';
        return {
          postId: p.postId, position: p.position, simulated: p.simulated, observedAt: p.observedAt, receivedAt,
          layers: Object.fromEntries(LAYERS.map(layer => [layer, readingView(p.layers[layer])])),
          power: { ...p.power, status: powerStatus, ageSeconds: freshness(p.observedAt),
            netGenerationW: p.power.solarOutputW - p.power.stationLoadW,
            batteries: p.power.batteries.map(b => ({ ...b, nominalStoredWh: b.capacityWh * b.stateOfChargePct / 100 })) },
        };
      });
    },
    resupply(compatibility, minimumChargePct = 80) {
      number(minimumChargePct, 0, 100, 'minimumChargePct');
      if (!compatibility) fail('compatibility query required');
      return this.list().flatMap(post => post.power.status !== 'fresh' ? [] : post.power.batteries
        .filter(b => b.compatibility === compatibility && b.status === 'available' && b.stateOfChargePct >= minimumChargePct)
        .map(battery => ({ postId: post.postId, position: post.position, simulated: post.simulated, battery,
          note: 'Candidate only; reachability, usable energy and reservation are not established.' })));
    },
  };
}

export const DEFAULT_FRONTEND_ORIGINS = ['localhost', '127.0.0.1'].flatMap(host =>
  [3000, 5173, 5500, 8080].map(port => `http://${host}:${port}`));

function layerSnapshot(posts, optical, missionId) {
  return Object.fromEntries(LAYERS.map(layer => [layer, [
    ...posts.map(post => ({ sourceType: 'post', sourceId: post.postId,
      postId: post.postId, position: post.position, simulated: post.simulated, ...post.layers[layer],
    })),
    ...(layer === 'optical' && optical ? optical.list({ missionId }, 100) : []),
  ]]));
}

export function createServer(store, { token = '', origin, origins = DEFAULT_FRONTEND_ORIGINS, optical = null } = {}) {
  const allowedOrigins = new Set(origin ? [origin] : origins);
  return http.createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('Vary', 'Origin');
    if (allowedOrigins.has(req.headers.origin)) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    try {
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return reply(403, { error: 'Frontend origin not allowed. Add its exact URL to config.json frontendOrigins and restart the backend.' });
      if (req.method === 'OPTIONS') return reply(200, {});
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return reply(200, { status: 'ok', mode: 'prototype' });
      if (optical && req.method === 'POST' && url.pathname === '/api/optical/images') {
        if (token && req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'Unauthorized' });
        const result = optical.ingest(await readJson(req, 6 * 1024 * 1024));
        return reply(result.duplicate ? 200 : 201, result);
      }
      if (optical && req.method === 'GET' && ['/api/optical/images', '/api/optical/latest'].includes(url.pathname)) {
        const filters = Object.fromEntries(['sourceType', 'sourceId', 'missionId'].map(key => [key, url.searchParams.get(key)]));
        if (url.pathname.endsWith('/latest')) return reply(200, { image: optical.latest(filters) });
        return reply(200, { images: optical.list(filters, Number(url.searchParams.get('limit') ?? 50)) });
      }
      if (optical && req.method === 'GET' && url.pathname.startsWith('/api/images/')) {
        const image = optical.readImage(url.pathname.slice('/api/images/'.length));
        res.writeHead(200, { 'Content-Type': image.mimeType, 'Content-Length': image.bytes.length,
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(image.bytes);
      }
      if (req.method === 'POST' && url.pathname === '/api/posts/telemetry') {
        if (token && req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'Unauthorized' });
        return reply(200, store.ingest(await readJson(req, 65536)));
      }
      if (req.method === 'GET' && url.pathname === '/api/posts') return reply(200, { posts: store.list() });
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        const missionId = url.searchParams.get('missionId') || 'demo-mission';
        const sourceId = url.searchParams.get('droneId') || 'drone-01';
        identifier(missionId); identifier(sourceId);
        const posts = store.list();
        return reply(200, {
          serverTime: new Date().toISOString(), missionId, coordinateFrame: 'demo-local-meters',
          posts, layers: layerSnapshot(posts, optical, missionId),
          latestDroneImage: optical?.latest({ sourceType: 'drone', sourceId, missionId }) ?? null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/layers') return reply(200, {
        coordinateFrame: 'demo-local-meters',
        layers: layerSnapshot(store.list(), optical, url.searchParams.get('missionId')),
      });
      if (req.method === 'GET' && url.pathname === '/api/resupply') return reply(200, {
        candidates: store.resupply(url.searchParams.get('compatibility'), Number(url.searchParams.get('minimumChargePct') ?? 80)),
      });
      reply(404, { error: 'Not found' });
    } catch (error) {
      if (!error.status) console.error(error);
      reply(error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  const store = createStore({ file: fileURLToPath(new URL('./data/posts.json', import.meta.url)) });
  const port = Number(process.env.PORT || config.port || 8787);
  const host = process.env.HOST || config.host || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && !process.env.POST_TOKEN) throw new Error('Set POST_TOKEN before enabling network access');
  const optical = createOpticalStore({ directory: fileURLToPath(new URL('./data', import.meta.url)) });
  const origins = process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN] : config.frontendOrigins;
  const server = createServer(store, { optical, token: process.env.POST_TOKEN, origins });
  server.requestTimeout = 30000;
  server.listen(port, host, () => {
    console.log(`Mars backend: http://${host}:${port}`);
    console.log(`Frontend connection check: http://${host}:${port}/health`);
    console.log(`Allowed frontend URLs: ${(origins || DEFAULT_FRONTEND_ORIGINS).join(', ')}`);
  });
}
