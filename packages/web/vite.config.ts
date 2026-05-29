import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
  request as httpRequest,
} from 'node:http';
import { type RequestOptions, request as httpsRequest } from 'node:https';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import react from '@vitejs/plugin-react';
import forge from 'node-forge';
import { defineConfig } from 'vite';

const certsDir = join(__dirname, '..', '..', 'certs');
const keyPath = join(certsDir, 'key.pem');
const certPath = join(certsDir, 'cert.pem');

function ensureCerts(): { key: string; cert: string } {
  // Prefer an explicitly-configured TRUSTED cert via env vars (point both at
  // absolute file paths) — e.g. `tailscale cert` output, or any real cert from
  // your own domain / VLAN. Browsers reject a self-signed cert when registering
  // the phone's Service Worker (that's what blocks phone Web Push); a trusted
  // cert here fixes it. Falls back to the self-signed pair below.
  const envCert = process.env.SWITCHBOARD_TLS_CERT;
  const envKey = process.env.SWITCHBOARD_TLS_KEY;
  if (envCert && envKey && existsSync(envCert) && existsSync(envKey)) {
    return { key: readFileSync(envKey, 'utf8'), cert: readFileSync(envCert, 'utf8') };
  }
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
  // Include all LAN IPs so phones on 192.168.x.x don't get cert mismatch
  const lanIps: Array<{ type: number; value?: string; ip?: string }> = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets ?? {})) {
    for (const i of ifaces as Array<{ address: string; family: string; internal: boolean }>) {
      if (!i.internal && i.family === 'IPv4') lanIps.push({ type: 7, ip: i.address });
    }
  }
  cert.setExtensions([{ name: 'subjectAltName', altNames: lanIps }]);
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
const HTTPS_PORT = 5173;

let actualHttpsPort = HTTPS_PORT;
let actualHttpPort = HTTP_PORT;

function getTargetConfig(req: IncomingMessage): {
  client: typeof httpRequest | typeof httpsRequest;
  options: RequestOptions;
} {
  const url = req.url || '';
  const headers = { ...req.headers };

  if (url.startsWith('/go2rtc')) {
    headers.host = '127.0.0.1:1984';
    if (headers.origin) {
      headers.origin = 'http://127.0.0.1:1984';
    }
    return {
      client: httpRequest,
      options: {
        hostname: '127.0.0.1',
        port: 1984,
        path: url.replace(/^\/go2rtc/, ''),
        method: req.method,
        headers,
      },
    };
  } else if (url.startsWith('/ws') || url.startsWith('/api')) {
    headers.host = '127.0.0.1:8787';
    if (headers.origin) {
      headers.origin = 'http://127.0.0.1:8787';
    }
    return {
      client: httpRequest,
      options: {
        hostname: '127.0.0.1',
        port: 8787,
        path: url,
        method: req.method,
        headers,
      },
    };
  } else {
    headers.host = `127.0.0.1:${actualHttpsPort}`;
    return {
      client: httpsRequest,
      options: {
        hostname: '127.0.0.1',
        port: actualHttpsPort,
        path: url,
        method: req.method,
        headers,
        rejectUnauthorized: false,
      },
    };
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'http-mirror',
      configureServer(server) {
        server.httpServer?.once('listening', () => {
          const address = server.httpServer?.address();
          if (address && typeof address === 'object') {
            actualHttpsPort = address.port;
          }

          // Hot-swap the TLS cert periodically so a renewed cert (from the daily
          // `tailscale cert` scheduled task) takes effect WITHOUT restarting the
          // dev server. Otherwise we keep serving the cert loaded at startup,
          // which would expire before a manual restart.
          const httpsServer = server.httpServer as unknown as {
            setSecureContext?: (opts: { key: string; cert: string }) => void;
          } | null;
          if (httpsServer?.setSecureContext) {
            const reloadMs = 12 * 60 * 60 * 1000;
            const certTimer = setInterval(() => {
              try {
                const fresh = ensureCerts();
                httpsServer?.setSecureContext?.({ key: fresh.key, cert: fresh.cert });
              } catch {
                // keep serving the current cert on any read error
              }
            }, reloadMs);
            certTimer.unref();
          }

          const mirror = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
            const { client, options } = getTargetConfig(req);
            const proxy = client(options, (proxyRes) => {
              res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
              proxyRes.pipe(res, { end: true });
            });
            proxy.on('error', (err) => {
              if (!res.headersSent) {
                res.writeHead(502);
                res.end(`mirror error: ${err.message}`);
              }
            });

            if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
              proxy.end();
            } else {
              req.pipe(proxy, { end: true });
            }
          });

          mirror.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
            const { client, options } = getTargetConfig(req);
            const upgradeOpts = { ...options, method: 'GET' };
            const proxy = client(upgradeOpts);
            proxy.on('upgrade', (proxyRes, proxySocket: Duplex, proxyHead: Buffer) => {
              let rawHeaders = `HTTP/1.1 101 ${proxyRes.statusMessage || 'Switching Protocols'}\r\n`;
              for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
                rawHeaders += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
              }
              rawHeaders += '\r\n';
              socket.write(rawHeaders);
              if (proxyHead.length) socket.write(proxyHead);
              proxySocket.pipe(socket);
              socket.pipe(proxySocket);
              proxySocket.on('error', () => socket.destroy());
              socket.on('error', () => proxySocket.destroy());
            });
            proxy.on('error', () => socket.destroy());
            if (head.length) proxy.write(head);
            proxy.end();
          });

          // 从 HTTPS 端口 + 1 开始尝试，避免端口冲突并实现自适应
          const startHttpPort = actualHttpsPort + 1;
          const listenWithRetry = (port: number) => {
            mirror.once('error', (err: any) => {
              if (err.code === 'EADDRINUSE') {
                listenWithRetry(port + 1);
              }
            });
            mirror.listen(port, '0.0.0.0', () => {
              actualHttpPort = port;
              console.log(
                `  HTTP:   http://localhost:${actualHttpPort} (all features except phone camera push)`,
              );
            });
          };

          listenWithRetry(startHttpPort);
        });
      },
    },
  ],
  server: {
    port: HTTPS_PORT,
    host: '0.0.0.0',
    // HMR disabled: phones reach the dev server over a self-signed-cert TLS link
    // that periodically resets (ECONNRESET); on each drop Vite's HMR client
    // reconnects and FULL-RELOADS the page — that's the "refreshes every few
    // seconds" bug. We never hot-reload from the phone anyway; edit code then
    // refresh manually (or serve a production build for real deployments).
    hmr: false,
    https: { key: tls.key, cert: tls.cert },
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
