import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
function url(value) {
  try {
    const parsed = new URL(value);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return value;
  } catch { /* Report a consistent validation error below. */ }
  fail('Expected an HTTP(S) URL without credentials');
}
function position(value) {
  if (value == null) return null;
  if (value.frame !== 'demo-local-meters' || !Number.isFinite(value.xM) || !Number.isFinite(value.yM)
      || Math.abs(value.xM) > 1e7 || Math.abs(value.yM) > 1e7) fail('Invalid demo-local-meters position');
  return { frame: value.frame, xM: value.xM, yM: value.yM };
}
function decodeImage(value, mimeType) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('Invalid base64 image or image exceeds 4 MiB');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) fail('Invalid base64 image or image exceeds 4 MiB');
  const png = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.toString('ascii', 12, 16) === 'IHDR';
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if (!((mimeType === 'image/png' && png) || (mimeType === 'image/jpeg' && jpeg))) fail('Use PNG/JPEG bytes matching mimeType');
  return bytes;
}

// A deliberately small, single-process image catalogue. Images are immutable.
export function createOpticalStore({ directory, clock = Date.now, staleAfterSeconds = 120 }) {
  mkdirSync(join(directory, 'images'), { recursive: true });
  const indexPath = join(directory, 'optical.json');
  let records = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
  function view(record) {
    const { digest, filename, ...publicRecord } = record;
    const ageSeconds = Math.max(0, (clock() - Date.parse(record.capturedAt)) / 1000);
    return { ...publicRecord, ageSeconds, status: record.sourceType === 'satellite' ? 'reference'
      : ageSeconds > staleAfterSeconds ? 'stale' : 'fresh' };
  }
  function matching({ sourceType, sourceId, missionId } = {}) {
    if (sourceType && !['drone', 'satellite'].includes(sourceType)) fail('sourceType must be drone or satellite');
    if (sourceId && !id(sourceId)) fail('Invalid sourceId');
    if (missionId && !id(missionId)) fail('Invalid missionId');
    return records.filter(r => (!sourceType || r.sourceType === sourceType) && (!sourceId || r.sourceId === sourceId)
      && (!missionId || r.missionId === missionId))
      .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt) || b.receivedAt.localeCompare(a.receivedAt));
  }
  return {
    ingest(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Expected an image object');
      for (const field of ['imageId', 'sourceId', 'missionId']) if (!id(input[field])) fail(`Invalid ${field}`);
      if (!['drone', 'satellite'].includes(input.sourceType)) fail('sourceType must be drone or satellite');
      if (typeof input.simulated !== 'boolean') fail('simulated must be explicit');
      if (typeof input.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(input.capturedAt)
        || !Number.isFinite(Date.parse(input.capturedAt)) || Date.parse(input.capturedAt) > clock() + 60000) fail('Invalid UTC capturedAt or future capture');
      if (typeof input.caption !== 'string' || !input.caption.trim() || input.caption.length > 500) fail('caption required (maximum 500 characters)');
      let bytes = null;
      const metadata = {
        imageId: input.imageId, sourceType: input.sourceType, sourceId: input.sourceId, missionId: input.missionId,
        capturedAt: new Date(input.capturedAt).toISOString(), simulated: input.simulated,
        position: position(input.position), caption: input.caption,
        sourceUrl: input.sourceUrl == null ? null : url(input.sourceUrl),
      };
      if (input.sourceType === 'drone') {
        if (!metadata.position) fail('Drone camera position is required');
        if (input.imageUrl != null) fail('Drone images require imageBase64, not imageUrl');
        bytes = decodeImage(input.imageBase64, input.mimeType);
        metadata.mimeType = input.mimeType;
      } else {
        if (input.imageBase64 != null) fail('Satellite images use external references only');
        metadata.imageUrl = url(input.imageUrl);
        if (!metadata.sourceUrl) fail('Satellite sourceUrl is required for attribution');
      }
      const digest = createHash('sha256').update(JSON.stringify(metadata)).update(bytes || '').digest('hex');
      const existing = records.find(r => r.missionId === metadata.missionId && r.sourceType === metadata.sourceType
        && r.sourceId === metadata.sourceId && r.imageId === metadata.imageId);
      if (existing) {
        if (existing.digest !== digest) fail('imageId already exists with different content', 409);
        return { duplicate: true, image: view(existing) };
      }
      let filename = null;
      if (bytes) {
        filename = `${digest}.${metadata.mimeType === 'image/png' ? 'png' : 'jpg'}`;
        writeFileSync(join(directory, 'images', filename), bytes);
        metadata.imageUrl = `/api/images/${filename}`;
      }
      const record = { ...metadata, filename, digest, receivedAt: new Date(clock()).toISOString() };
      const next = [...records, record];
      writeFileSync(`${indexPath}.tmp`, JSON.stringify(next, null, 2));
      renameSync(`${indexPath}.tmp`, indexPath);
      records = next;
      return { duplicate: false, image: view(record) };
    },
    list(filters = {}, limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('limit must be 1 to 100');
      return matching(filters).slice(0, limit).map(view);
    },
    latest(filters = {}) { const record = matching(filters)[0]; return record ? view(record) : null; },
    readImage(filename) {
      if (!/^[a-f0-9]{64}\.(png|jpg)$/.test(filename)) fail('Image not found', 404);
      const record = records.find(r => r.filename === filename);
      if (!record) fail('Image not found', 404);
      return { bytes: readFileSync(join(directory, 'images', filename)), mimeType: record.mimeType };
    },
  };
}

export async function readJson(req, maxBytes) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('Content-Type must be application/json', 415);
  // Consume an oversized request without storing it, so a JSON 413 can be returned.
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) fail('Request body is too large', 413);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Invalid JSON'); }
}
