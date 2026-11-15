// Copy this file into your teammate's frontend. No additional packages needed.
// Do not put POST_TOKEN in the frontend: this client only reads public demo data.
export function createMarsClient({
  baseUrl = 'http://127.0.0.1:8787', missionId = 'demo-mission', droneId = 'drone-01', timeoutMs = 10000,
} = {}) {
  const backend = new URL(baseUrl);
  if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password) throw new Error('Use an HTTP(S) backend URL without credentials');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  // Preserve external satellite URLs; resolve local photo paths to the backend.
  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      [key, key === 'imageUrl' && typeof entry === 'string' ? new URL(entry, backend).href : normalize(entry)]));
    return value;
  }
  async function get(path, query = {}, { signal } = {}) {
    const url = new URL(path, backend);
    for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, value);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error || `Backend error ${response.status}`), { status: response.status });
      return normalize(body);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timedOut) throw new Error(`Mars backend timed out at ${backend.origin}. Check that it is running.`);
      if (error instanceof TypeError) throw new Error(`Cannot reach Mars backend at ${backend.origin}. Check its address, network, and config.json frontendOrigins.`);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
  const getDashboard = (options) => get('/api/dashboard', { missionId, droneId }, options);
  return {
    checkConnection: (options) => get('/health', {}, options),
    getDashboard,
    getLayers: (options) => get('/api/layers', { missionId }, options),
    getPosts: (options) => get('/api/posts', {}, options),
    getLatestDroneImage: async (options) => (await get('/api/optical/latest', { sourceType: 'drone', sourceId: droneId, missionId }, options)).image,
    getResupply: (compatibility, minimumChargePct = 80, options) => get('/api/resupply', { compatibility, minimumChargePct }, options),
    watchDashboard({ onData, onError = console.error, intervalMs = 3000 }) {
      if (typeof onData !== 'function' || typeof onError !== 'function') throw new Error('onData and onError must be functions');
      if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new Error('intervalMs must be at least 100');
      let stopped = false; let timer;
      const controller = new AbortController();
      async function poll() {
        try {
          const data = await getDashboard({ signal: controller.signal });
          if (!stopped) await onData(data);
        } catch (error) {
          if (!stopped) {
            try { await onError(error); } catch (callbackError) { console.error(callbackError); }
          }
        } finally {
          // Schedule after completion: slow requests never overlap.
          if (!stopped) timer = setTimeout(poll, intervalMs);
        }
      }
      void poll();
      return () => { stopped = true; clearTimeout(timer); controller.abort(); };
    },
  };
}
