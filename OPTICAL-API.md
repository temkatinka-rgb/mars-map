# Drone and satellite optical data

For the easiest frontend setup, use **frontend-client.js** and follow
**CONNECT-FRONTEND.md**. The helper combines requests with /api/dashboard,
resolves image URLs and handles periodic updates. Browser origins are configured
in config.json; FRONTEND_ORIGIN is an optional single-origin override.

Backend only. No frontend, drone flight controller, camera driver or satellite
downlink is included. A sender on the rover/drone computer submits captured photos
over HTTP. Satellite images are registered by URL and attribution. The backend
does not download external images or verify their scientific metadata.

## Quick start in Visual Studio Code

1. Install Node.js 22 or later if needed. No npm install is required.
2. Open `Mars Backend.code-workspace` in VS Code.
3. Press F5 and choose **Start Mars backend** (or run `node server.mjs`).
4. In another terminal run `node drone-simulator.mjs`.
5. Open the returned Photo URL. The default is a tiny 1-pixel transfer-test image.
6. For a real visible picture, run `node drone-simulator.mjs "C:\path\photo.jpg"`.

The supplied photo is still labeled simulated because the simulator invents its
position and capture time. For a real sender, supply actual metadata. This API
supports individual PNG/JPEG photos up to 4 MiB, not live video. Images travel as
base64 inside JSON for a simple one-request interface; this increases transfer
size. Send selected frames, not every video frame. Request limit: 6 MiB.

## Upload one drone photo

POST `/api/optical/images`, Content-Type: application/json.
Add Authorization: Bearer YOUR_TOKEN when POST_TOKEN is configured.

```json
{
  "imageId": "flight1-frame001",
  "sourceType": "drone",
  "sourceId": "drone-01",
  "missionId": "demo-mission",
  "capturedAt": "2026-11-15T00:00:00Z",
  "simulated": true,
  "position": { "frame": "demo-local-meters", "xM": 1250, "yM": 430 },
  "caption": "Simulated route survey ahead of the rover",
  "mimeType": "image/jpeg",
  "imageBase64": "REPLACE_WITH_BASE64_IMAGE_BYTES"
}
```

Send only base64 bytes, without a data:image/... prefix. The position is the
camera's estimated position, not a mapped image footprint. Metadata needs a real
coordinate conversion before overlaying on a Mars map. Do not derive obstacles,
thermal measurements or radiation from these images without a separate model.

Returns 201 with `{ "duplicate": false, "image": { ... } }`. The image contains
imageUrl, capturedAt, receivedAt, sourceId, missionId, simulated, position,
caption, ageSeconds and status. A local imageUrl starts with `/api/images/`.
Resolve it against the BACKEND address, not the frontend address.

Retries of the same source/mission/imageId with the same content return 200 and
duplicate=true. Reusing it with changed content returns 409. Delayed images are
stored, but latest is determined by capture time, so they cannot displace newer
captures. Captures more than 60 seconds ahead of server time are rejected.
Drone observations become stale after the configurable 120-second demo threshold.

## Side-panel image contract for your frontend teammate

Poll every 2-5 seconds:

GET `/api/optical/latest?sourceType=drone&sourceId=drone-01&missionId=demo-mission`

Response: `{ "image": null }` before the first image. Otherwise image contains
the URL and metadata. Only change the displayed picture when imageId changes.
Keep an older picture visible with a stale label when the feed stops.

Integration snippet (documentation only, no frontend is built):

```javascript
const backend = 'http://127.0.0.1:8787';
const response = await fetch(`${backend}/api/optical/latest?sourceType=drone&sourceId=drone-01&missionId=demo-mission`);
if (!response.ok) throw new Error('Drone image request failed');
const { image } = await response.json();
if (image) {
  const photoUrl = new URL(image.imageUrl, backend).href;
  // Give photoUrl to the side-panel image component.
  // Show image.caption, image.capturedAt, image.status and image.simulated.
}
```

## Satellite references

Use the same POST endpoint with sourceType=satellite, sourceId, missionId,
imageId, capturedAt, simulated, caption, imageUrl and sourceUrl. position may be
null when you do not have local coordinates. No imageBase64 is allowed here.
sourceUrl is the original dataset or image information page. imageUrl must point
to an image suitable for browser display, not an HTML gallery or a raw GeoTIFF.
Satellite records are labeled reference, not live weather or a fresh drone view.

```powershell
node satellite-register.mjs 'https://your-source/direct-image.jpg' '2025-01-01T00:00:00Z' 'https://your-source/image-details'
```

The URLs above are placeholders. Supply verified source URLs and the actual
capture timestamp. This command labels them as real archived observations, so
do not use it to mislabel fictional imagery. Hosted references may be unavailable
offline; the backend's uploaded drone images remain local.

## Other optical endpoints

| Endpoint | Result |
| --- | --- |
| GET /api/optical/images?sourceType=drone&missionId=demo-mission&limit=20 | Newest captures first; limit 1-100 |
| GET /api/optical/latest?sourceType=satellite&missionId=demo-mission | Latest orbital reference |
| GET /api/layers?missionId=demo-mission | Four layers; optical includes post, drone and satellite entries |
| GET /api/images/HASH.png | Uploaded photo bytes with image content type |

`/api/layers` keeps existing post entries and adds up to 100 optical records.
The mission filter applies to drone/satellite records; posts remain shared fixed
infrastructure. Use `/api/optical/latest` for the drone side panel, not the first
entry in the combined optical layer. Satellite observations with null position
can be shown in the side panel but cannot be placed on a map automatically.

## Connecting a teammate's machine

By default the backend only accepts local connections. For a trusted local demo
network, set HOST=0.0.0.0 and POST_TOKEN to a secret before starting. The sender
uses API_URL=http://BACKEND_LAN_IP:8787 and the same POST_TOKEN. Set FRONTEND_ORIGIN
to the exact frontend origin, including scheme and port, then restart the server.
On a different computer, localhost refers to that computer, not this backend.
Read endpoints are unauthenticated. Use TLS and proper access control before
public deployment; the current shared token is a prototype arrangement.

## Storage and limits

`data/optical.json` stores metadata. `data/images/` stores immutable files.
The catalogue survives restart and is intended for a single backend process.
No automatic deletion is performed: monitor disk space for a long demo.
No upload chunking, image resizing, full image decoding, reservation system or
offline retry queue is included. PNG/JPEG headers are checked, not every pixel.
The drone simulator retries transient failures three times with the same payload.
The archive contains source and tests, not user photos or runtime data.
