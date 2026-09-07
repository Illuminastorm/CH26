// Picking the right local address is the single most common way this setup
// fails: the machine has ~7 IPv4 addresses and only one of them is the one
// the phone can reach.
import { networkInterfaces } from 'node:os';

const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|TAP|Tailscale|ZeroTier/i;

export function lanAddresses() {
  const found = [];

  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // 169.254.x.x is APIPA: the adapter failed to get a DHCP lease and is
      // not on a real network. Never reachable from the phone.
      if (a.address.startsWith('169.254.')) continue;
      found.push({ address: a.address, iface: name, virtual: VIRTUAL.test(name) });
    }
  }

  // Real adapters before virtual ones; Wi-Fi first, since that is the one the
  // phone shares.
  return found.sort((a, b) =>
    Number(a.virtual) - Number(b.virtual) ||
    Number(!/Wi-?Fi|Wireless|WLAN/i.test(a.iface)) - Number(!/Wi-?Fi|Wireless|WLAN/i.test(b.iface))
  );
}
