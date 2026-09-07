// Generates a self-signed cert covering localhost + every LAN IPv4 on this
// machine. Phones need a real IP match in the SAN or the TLS warning becomes
// unskippable on iOS. Regenerates automatically when the machine's addresses
// change, which happens on every network switch and DHCP lease change.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lanAddresses } from './net.mjs';

export function ensureCert(dir) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const ipsPath = path.join(dir, 'ips.txt');

  const nics = lanAddresses();
  const fingerprint = nics.map((n) => n.address).join(',');
  const previous = existsSync(ipsPath) ? readFileSync(ipsPath, 'utf8') : null;

  if (existsSync(keyPath) && existsSync(certPath) && previous === fingerprint) {
    return {
      key: readFileSync(keyPath), cert: readFileSync(certPath),
      nics, regenerated: false, previous,
    };
  }

  mkdirSync(dir, { recursive: true });
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...nics.map((n) => `IP:${n.address}`)].join(',');

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '825', '-subj', '/CN=accel-bridge',
    '-addext', `subjectAltName=${san}`,
  ], { stdio: 'pipe' });

  writeFileSync(ipsPath, fingerprint);
  return {
    key: readFileSync(keyPath), cert: readFileSync(certPath),
    nics, regenerated: true, previous,
  };
}
