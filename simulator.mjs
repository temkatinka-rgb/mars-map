import { randomUUID } from 'node:crypto';

// Synthetic values and local coordinates; these are not NASA measurements.
const observedAt = new Date().toISOString();
const packet = {
  postId: 'urtuu-01', messageId: randomUUID(), observedAt, simulated: true,
  position: { frame: 'demo-local-meters', xM: 1200, yM: 400 },
  layers: {
    weather: { observedAt, sensorId: 'weather-01', airTemperatureC: -45, pressurePa: 650, windSpeedMps: 8, windDirectionDeg: 120 },
    // Supply an actual hosted image URL to demonstrate the optical layer.
    optical: process.env.DEMO_IMAGE_URL ? { observedAt, sensorId: 'camera-01', imageUrl: process.env.DEMO_IMAGE_URL } : null,
    thermal: null,
    radiation: null,
  },
  power: { solarOutputW: 400, stationLoadW: 100, batteries: [
    { id: 'pack-01', compatibility: 'demo-rover-pack-v1', capacityWh: 2000, stateOfChargePct: 90, status: 'available' },
    { id: 'pack-02', compatibility: 'demo-rover-pack-v1', capacityWh: 2000, stateOfChargePct: 35, status: 'charging' },
  ] },
};
const response = await fetch(`${process.env.API_URL || 'http://127.0.0.1:8787'}/api/posts/telemetry`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.POST_TOKEN ? { Authorization: `Bearer ${process.env.POST_TOKEN}` } : {}) },
  body: JSON.stringify(packet),
});
console.log(response.status, await response.json());
if (!response.ok) process.exitCode = 1;
