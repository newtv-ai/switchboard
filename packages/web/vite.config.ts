import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
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
const HTTPS_PORT = 5173;

let actualHttpsPort = HTTPS_PORT;
let actualHttpPort = HTTP_PORT;

function makeProxyOpts(req: IncomingMessage): RequestOptions {
  const headers = { ...req.headers };
  // Rewrite Host to target HTTPS port to satisfy Vite's host checking
  headers.host = `127.0.0.1:${actualHttpsPort}`;
  return {
    hostname: '127.0.0.1',
    port: actualHttpsPort,
    path: req.url,
    method: req.method,
    headers: headers,
    rejectUnauthorized: false,
  };
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
          
          const mirror = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
            const proxy = httpsRequest(makeProxyOpts(req), (proxyRes) => {
              res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
              proxyRes.pipe(res, { end: true });
            });
            proxy.on('error', (err) => {
              if (!res.headersSent) { res.writeHead(502); res.end(`mirror error: ${err.message}`); }
            });
            
            if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
              proxy.end();
            } else {
              req.pipe(proxy, { end: true });
            }
          });

          mirror.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
            const proxy = httpsRequest({ ...makeProxyOpts(req), method: 'GET' });
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
              console.log(`  HTTP:   http://localhost:${actualHttpPort} (all features except phone camera push)`);
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
    https: { key: tls.key, cert: tls.cert },
    hmr: {
      port: HTTPS_PORT,
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
