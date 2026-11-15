import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// A tiny synthetic test image is used when no photo file is supplied.
const placeholder = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEioAAAAASUVORK5CYII=';
const photoPath = process.argv[2];
const bytes = photoPath ? readFileSync(photoPath) : Buffer.from(placeholder, 'base64');
const packet = {
  imageId: randomUUID(), sourceType: 'drone', sourceId: 'drone-01', missionId: 'demo-mission',
  capturedAt: new Date().toISOString(), simulated: true,
  position: { frame: 'demo-local-meters', xM: 1250, yM: 430 },
  caption: photoPath ? 'Demo drone observation: supplied photo with simulated position/time.' : 'Transfer test only: synthetic 1-pixel image, not Mars imagery.',
  mimeType: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg', imageBase64: bytes.toString('base64'),
};
const base = process.env.API_URL || 'http://127.0.0.1:8787';
// Retries use the identical imageId and payload, preventing duplicate uploads.
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const response = await fetch(`${base}/api/optical/images`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(process.env.POST_TOKEN ? { Authorization: `Bearer ${process.env.POST_TOKEN}` } : {}) },
      body: JSON.stringify(packet),
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status < 500) { console.error(body); process.exitCode = 1; break; }
      throw new Error(body.error);
    }
    console.log('Image received:', JSON.stringify(body, null, 2));
    console.log('Photo URL:', new URL(body.image.imageUrl, base).href);
    break;
  } catch (error) {
    if (attempt === 2) { console.error(error.message); process.exitCode = 1; }
    else await delay(500 * (attempt + 1));
  }
}
