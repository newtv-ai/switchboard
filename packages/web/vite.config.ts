import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const certsDir = join(__dirname, '..', '..', 'certs');
const keyPath = join(certsDir, 'key.pem');
const certPath = join(certsDir, 'cert.pem');

// HTTPS is opt-in: only enabled when certs/key.pem + cert.pem exist.
// Users who need phone camera push (getUserMedia requires HTTPS) can
// generate certs by running: node -e "require('./packages/web/gen-cert')"
// or placing their own key.pem + cert.pem in the certs/ directory.
const hasHttps = existsSync(keyPath) && existsSync(certPath);
const httpsConfig = hasHttps
  ? { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') }
  : undefined;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    ...(httpsConfig ? { https: httpsConfig } : {}),
    proxy: {
      '/go2rtc': {
        target: 'http://127.0.0.1:1984',
        ws: true,
        rewrite: (path) => path.replace(/^\/go2rtc/, ''),
      },
      '/ws': {
        target: 'http://127.0.0.1:8787',
        ws: true,
      },
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
