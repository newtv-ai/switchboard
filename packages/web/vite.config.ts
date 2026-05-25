import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Phase 1: web runs on :5173 (Vite default), connects to server WS at :8787.
// Phase 2+: bind web to all interfaces so phone over Tailscale can reach it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Force IPv4 0.0.0.0; `host: true` on Windows can bind to `::` only (no
    // dual-stack), making LAN access via 192.168.x.x fail while Tailscale
    // happens to work via IPv6/dual-stack.
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
