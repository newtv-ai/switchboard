#!/usr/bin/env node
// Generate self-signed HTTPS certificate for phone camera push.
// Run: node packages/web/gen-cert.js
const { existsSync, mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const forge = require('node-forge');

const certsDir = join(__dirname, '..', '..', 'certs');
const keyPath = join(certsDir, 'key.pem');
const certPath = join(certsDir, 'cert.pem');

if (existsSync(keyPath) && existsSync(certPath)) {
  console.log('Certs already exist at', certsDir);
  process.exit(0);
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
const os = require('os');
const lanIps = [
  { type: 2, value: 'localhost' },
  { type: 7, ip: '127.0.0.1' },
];
for (const ifaces of Object.values(os.networkInterfaces() ?? {})) {
  for (const i of ifaces) {
    if (!i.internal && i.family === 'IPv4') lanIps.push({ type: 7, ip: i.address });
  }
}
cert.setExtensions([{ name: 'subjectAltName', altNames: lanIps }]);
cert.sign(keys.privateKey, forge.md.sha256.create());

writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey));
writeFileSync(certPath, forge.pki.certificateToPem(cert));
console.log('Generated self-signed HTTPS cert in', certsDir);
console.log('Restart the server to enable HTTPS.');
