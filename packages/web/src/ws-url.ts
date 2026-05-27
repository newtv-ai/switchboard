const HOST = window.location.hostname;
const PORT = 8787;

// Auto-pick WS scheme + host to match the page origin so we work over
// http://tailscale-ip:5173 and (future) https://… alike.
export const WS_BASE = (() => {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${HOST}:${PORT}`;
})();

// For HTTP fetch: use page origin (works with Vite proxy in dev, and same-origin in prod)
export const HTTP_BASE = window.location.origin;
