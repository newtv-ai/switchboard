#!/usr/bin/env node
// Renew the Tailscale HTTPS cert into certs/tailscale.{crt,key}.
//
// Tailscale auto-renews a cert when it's near expiry; calling `tailscale cert`
// when the cert is still fresh just returns the existing one (cheap no-op). So
// running this on a schedule (or every `npm run dev`) keeps the cert valid with
// no manual steps.
//
// Best-effort by design: it NEVER throws and always exits 0, so it's safe to
// chain before other commands and harmless for users who don't use Tailscale.
//
// Point the dev server at the output via env vars:
//   SWITCHBOARD_TLS_CERT=<repo>/certs/tailscale.crt
//   SWITCHBOARD_TLS_KEY =<repo>/certs/tailscale.key
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const certsDir = join(__dirname, '..', '..', 'certs');
const certPath = join(certsDir, 'tailscale.crt');
const keyPath = join(certsDir, 'tailscale.key');

function tailscaleBin() {
  // Windows default install location, else trust PATH.
  const win = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  return existsSync(win) ? win : 'tailscale';
}

try {
  const ts = tailscaleBin();
  const status = JSON.parse(execFileSync(ts, ['status', '--json'], { encoding: 'utf8' }));
  if (status.BackendState !== 'Running') {
    console.log('[cert] Tailscale not running — skipping cert renew');
    process.exit(0);
  }
  const domain = String(status.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!domain) {
    console.log('[cert] no tailnet DNS name — skipping cert renew');
    process.exit(0);
  }
  mkdirSync(certsDir, { recursive: true });
  console.log(`[cert] ensuring Tailscale cert for ${domain} ...`);
  execFileSync(ts, ['cert', '--cert-file', certPath, '--key-file', keyPath, domain], {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 90_000,
  });
  console.log(
    `[cert] ready:\n  SWITCHBOARD_TLS_CERT=${certPath}\n  SWITCHBOARD_TLS_KEY=${keyPath}`,
  );
} catch (err) {
  // Most common: HTTPS not enabled in the tailnet admin console yet, or the
  // tailscale CLI isn't installed. Don't fail the caller.
  console.warn(`[cert] renew skipped: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
