import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import forge from 'node-forge';
import { defineConfig } from 'vite';

const certsDir = join(__dirname, '..', '..', 'certs');
const keyPath = join(certsDir, 'key.pem');
const certPath = join(certsDir, 'cert.pem');

function ensureCerts(): { key: string; cert: string } {
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
  }
  mkdirSync(certsDir, { recursive: true });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

  const attrs = [{ name: 'commonName', value: 'switchboard' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
    ]},
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  writeFileSync(keyPath, keyPem);
  writeFileSync(certPath, certPem);
  console.log('[switchboard] auto-generated HTTPS cert in certs/');
  return { key: keyPem, cert: certPem };
}

const tls = ensureCerts();
const HTTP_PORT = 5174;

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'http-mirror',
      configureServer(server) {
        // Create a plain HTTP server sharing Vite's middleware stack.
        // Same UI, same proxy — just no TLS. For users who don't need
        // phone camera push (getUserMedia requires HTTPS).
        server.httpServer?.once('listening', () => {
          const httpServer = createHttpServer(server.middlewares);
          httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
            console.log(`  HTTP:   http://0.0.0.0:${HTTP_PORT} (all features except phone camera push)`);
            console.log(`  HTTPS:  https://0.0.0.0:5173 (full features including phone camera)`);
          });
          httpServer.on('error', () => { /* port busy, skip */ });
        });
      },
    },
  ],
  server: {
    port: 5173,
    host: '0.0.0.0',
    https: { key: tls.key, cert: tls.cert },
    hmr: {
      port: 5173,
      protocol: 'wss',
    },
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
