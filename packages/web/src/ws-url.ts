// Use page origin for all requests — Vite proxy forwards /ws and /api to server.
// This works for both http and https, dev and prod.
const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
export const WS_BASE = `${scheme}://${window.location.host}`;
export const HTTP_BASE = window.location.origin;
