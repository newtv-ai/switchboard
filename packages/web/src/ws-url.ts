// Auto-pick WS scheme + host to match the page origin so we work over
// http://tailscale-ip:5173 and (future) https://… alike.
export const WS_BASE = (() => {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.hostname}:8787`;
})();
