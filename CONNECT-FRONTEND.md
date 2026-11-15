# Connect your teammate's frontend

The backend is ready; this project does not build or replace your teammate's UI.
Give your teammate **frontend-client.js** and this guide. The client works with
browser JavaScript, React, Vue, and other frontend frameworks using ES modules.
It needs no additional libraries. Keep upload tokens out of the browser.

## 1. Start the backend

Open this folder in VS Code. In Terminal > New Terminal:

```powershell
node server.mjs
```

Keep it running. Open http://127.0.0.1:8787/health in your browser. You should see
`{"status":"ok","mode":"prototype"}`.

In another terminal, send demo data:

```powershell
node simulator.mjs
node drone-simulator.mjs "C:\path\your-photo.jpg"
```

Use the actual path to your picture. Running the drone sender without a picture
uses a tiny transfer-test image. The sender labels all its data simulated.

## 2. Your teammate copies one file

Copy **frontend-client.js** into the frontend's source folder, for example
`src/frontend-client.js`. Import it from wherever their integration code lives:

```javascript
import { createMarsClient } from './frontend-client.js';

const mars = createMarsClient({
  baseUrl: 'http://127.0.0.1:8787',
  missionId: 'demo-mission',
  droneId: 'drone-01',
});

const data = await mars.getDashboard();
console.log(data.layers);              // weather, optical, thermal, radiation
console.log(data.posts);               // urtuu reports and battery inventory
console.log(data.latestDroneImage);    // null before first upload
console.log(data.latestDroneImage?.imageUrl); // ready-to-use absolute image URL
```

Run this inside the frontend's normal startup/component code. Adjust the import
path to where the file was copied. The helper always makes image URLs point at
the backend; external satellite URLs remain external.

## 3. Automatic updates

```javascript
const stop = mars.watchDashboard({
  intervalMs: 3000,
  onData(data) {
    // Your teammate updates their component state here.
    console.log('Connected', data);
  },
  onError(error) {
    // Show disconnected status. Keep old data labeled as old/disconnected.
    console.error(error.message);
  },
});

// Call stop() when the screen closes/unmounts.
```

React example to place inside an existing component (import useEffect/useState):

```javascript
const [data, setData] = useState(null);
const [error, setError] = useState(null);

useEffect(() => {
  const mars = createMarsClient({ baseUrl: 'http://127.0.0.1:8787' });
  return mars.watchDashboard({
    onData(next) { setData(next); setError(null); },
    onError(problem) { setError(problem.message); },
  });
}, []);

// In your teammate's existing JSX:
// {error && <p role="status">Disconnected: {error}</p>}
// {data?.latestDroneImage && <img
//   src={data.latestDroneImage.imageUrl}
//   alt={data.latestDroneImage.caption}
// />}
```

Display capture time, stale/unknown labels and simulated indicators alongside
the data. A failed connection must not make old readings look current. A stale
image is still usable as a historical image, but not a live view. Handle null
latestDroneImage by showing 'Waiting for drone photo'.

## 4. Frontend address settings

The backend accepts frontend pages served from localhost or 127.0.0.1 on ports
3000, 5173, 5500 and 8080 by default. If your frontend uses another address,
add its exact origin (scheme, host, port; no path/trailing slash) to
**config.json > frontendOrigins**, then restart the backend. FRONTEND_ORIGIN,
if set in the terminal environment, overrides the list.

Do not open frontend HTML by double-clicking a file. Use the frontend's development
server; a file:// page has no allowed web origin. If the frontend is hosted using
HTTPS, use an HTTPS backend or development proxy; browsers may block HTTP calls.

## 5. If you use separate laptops

Both devices must be able to reach each other on the local network.

On the BACKEND laptop, in PowerShell:

```powershell
$env:HOST = '0.0.0.0'
$env:POST_TOKEN = 'replace-with-a-private-demo-token'
node server.mjs
```

Find that laptop's Wi-Fi IPv4 address in Windows network settings (or ipconfig).
For example, if it is 192.168.1.10, the teammate uses:

```javascript
const mars = createMarsClient({ baseUrl: 'http://192.168.1.10:8787' });
```

They can test http://192.168.1.10:8787/health in their browser first. If it fails,
check the address, network isolation and Windows Firewall's private-network
permission for Node. The laptop's address may change on a different network.

In config.json add the exact address shown in the teammate's FRONTEND browser
address bar. If they open http://localhost:5173 on their own laptop, that origin
is already allowed. If they open http://192.168.1.20:5173, add that origin.
Restart after editing config.json. Use the same POST_TOKEN only in your sender
terminal when sending reports/photos. The frontend never needs that token.
This remains a local prototype with public read endpoints, not a public deployment.

## Available helper methods

| Method | Result |
| --- | --- |
| checkConnection() | {status, mode} |
| getDashboard() | {serverTime, missionId, coordinateFrame, posts, layers, latestDroneImage} |
| getLayers() | {coordinateFrame, layers} |
| getPosts() | {posts} |
| getLatestDroneImage() | Image object or null |
| getResupply('demo-rover-pack-v1', 80) | {candidates} |
| watchDashboard({onData, onError}) | Stop function; refreshes every 3 seconds |

All one-time methods return promises. getDashboard() also accepts {signal} for
optional cancellation. Requests time out after 10 seconds; configure timeoutMs
in createMarsClient if needed. Polling waits for the previous request/callback
to finish, so slow connections cannot accumulate overlapping requests.

Without the helper, the main endpoint is:
GET /api/dashboard?missionId=demo-mission&droneId=drone-01

Coordinates remain demo-local-meters, not latitude/longitude. The map must use
the agreed frame or convert it explicitly. Posts are shared infrastructure;
the mission filter selects drone/satellite images, not post reports.
