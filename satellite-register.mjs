import { randomUUID } from 'node:crypto';

// Pass a direct image URL, the actual UTC capture date, and its source page.
const [imageUrl, capturedAt, sourceUrl] = process.argv.slice(2);
if (!imageUrl || !capturedAt || !sourceUrl) {
  console.error('Usage: node satellite-register.mjs IMAGE_URL CAPTURED_AT_UTC SOURCE_PAGE_URL');
  process.exitCode = 1;
} else {
  const response = await fetch(`${process.env.API_URL || 'http://127.0.0.1:8787'}/api/optical/images`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.POST_TOKEN ? { Authorization: `Bearer ${process.env.POST_TOKEN}` } : {}) },
    body: JSON.stringify({ imageId: randomUUID(), sourceType: 'satellite', sourceId: process.env.SATELLITE_ID || 'orbital-reference',
      missionId: 'demo-mission', capturedAt, simulated: false, position: null,
      imageUrl, sourceUrl, caption: 'User-supplied archived orbital image reference; consult source page for attribution and coverage.' }),
  });
  console.log(response.status, await response.json());
  if (!response.ok) process.exitCode = 1;
}
