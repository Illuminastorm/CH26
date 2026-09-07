// Accelerometer bridge: phone (Android or iOS) -> laptop, over WiFi + WSS.
import { createServer } from 'node:https';
import { connect } from 'node:tls';
import { readFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.mjs';
import { ensureCert } from './cert.mjs';
import { createFuser } from '../web/fuse.mjs';
import { createShakeGuard } from './shake-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8443);
const LOG = process.env.LOG ? path.resolve(process.env.LOG) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const { key, cert, nics, regenerated, previous } = ensureCert(path.join(ROOT, 'certs'));

const server = createServer({ key, cert }, async (req, res) => {
  const url = new URL(req.url, 'https://localhost');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;

  // Contain path traversal: resolve, then verify the result stays under WEB.
  const target = path.resolve(WEB, '.' + file);
  if (target !== WEB && !target.startsWith(WEB + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// --- live state -------------------------------------------------------------
const monitors = new Set();
let streamingConnections = 0;
let logStream = null;
let sampleCount = 0;
let lastSample = null;
let rateWindow = [];

function status() {
  return {
    type: 'status',
    // An idle phone page should not make a round startable. A connection is
    // considered live only after the phone has begun sending sensor samples.
    connected: streamingConnections > 0,
    players: [1, 2].map((slot) => streamingSlots[slot] > 0),
    streamCount: streamingConnections,
    playerStreamCounts: [streamingSlots[1], streamingSlots[2]],
  };
}
const streamingSlots = { 1: 0, 2: 0 };

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const m of monitors) m.send(text);
}

attachWebSocket(server, (ws) => {
  const role = ws.url.startsWith('/monitor') ? 'monitor' : 'phone';

  if (role === 'monitor') {
    monitors.add(ws);
    ws.on('close', () => monitors.delete(ws));
    ws.send(JSON.stringify(status()));
    if (lastSample) ws.send(JSON.stringify(lastSample));
    return;
  }

  let device = 'unknown';
  let player = null;
  let streaming = false;
  // Filter state is per connection, so a reconnect starts clean rather than
  // carrying a stale gravity vector from the previous session.
  const fuse = createFuser();
  const shakeGuard = createShakeGuard();
  console.log('[phone] connected');
  broadcast(status());

  ws.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.type === 'hello') {
      const requestedPlayer = Number(msg.player);
      if (streaming && player) streamingSlots[player]--;
      player = requestedPlayer === 1 || requestedPlayer === 2 ? requestedPlayer : null;
      if (streaming && player) streamingSlots[player]++;
      device = `${msg.platform || '?'} / ${msg.ua || '?'}`;
      console.log(`[phone] hello: ${device} as P${player || '?'} @ ${msg.hz || '?'}Hz target`);
      broadcast({ type: 'hello', ...msg, player });
      broadcast(status());
      return;
    }

    if (msg.type === 'streaming') {
      const nextStreaming = msg.active === true;
      if (streaming === nextStreaming) return;
      streaming = nextStreaming;
      streamingConnections += streaming ? 1 : -1;
      if (player) streamingSlots[player] += streaming ? 1 : -1;
      broadcast(status());
      return;
    }

    if (msg.type !== 'accel') return;
    // Never relay samples before Start or after Stop on the phone.
    if (!streaming) return;

    sampleCount++;
    const f = fuse(msg);
    // Fused linear acceleration: the reliable output. Raw axes are kept so the
    // monitor can show what the filtering actually removed.
    msg.fx = round(f.x); msg.fy = round(f.y); msg.fz = round(f.z);
    msg.fmag = round(f.mag);
    msg.hwWeight = round(f.hwWeight);
    msg.gErr = round(f.gravityError);
    msg.settled = f.settled;
    msg.sources = f.sources;
    msg.player = player;
    // This is calculated after fusion, so gravity and device orientation do
    // not turn into false shake detections.  Clients must never score a
    // blocked sample.
    const shake = shakeGuard({ t: msg.t, x: f.x, y: f.y, z: f.z });
    msg.shake = shake.blocked;
    msg.shakeDetected = shake.detected;
    lastSample = msg;

    const now = Date.now();
    rateWindow.push(now);
    if (rateWindow.length > 120) rateWindow.shift();

    broadcast(msg);
    // A write stream keeps rows in arrival order; concurrent appendFile calls
    // race and interleave.
    logStream?.write(
      `${msg.t},${msg.x},${msg.y},${msg.z},${msg.ax ?? ''},${msg.ay ?? ''},${msg.az ?? ''},` +
      `${msg.fx},${msg.fy},${msg.fz},${msg.fmag},${msg.hwWeight},${msg.settled ? 1 : 0}\n`
    );

    if (sampleCount % 100 === 0) {
      const span = (rateWindow.at(-1) - rateWindow[0]) / 1000;
      const hz = span > 0 ? (rateWindow.length - 1) / span : 0;
      process.stdout.write(
        `\r[${hz.toFixed(0).padStart(3)} Hz] ` +
        `fused x=${fmt(msg.fx)} y=${fmt(msg.fy)} z=${fmt(msg.fz)} ` +
        `|a|=${fmt(msg.fmag)}  hw=${(msg.hwWeight * 100).toFixed(0)}%  n=${sampleCount}   `
      );
    }
  });

  ws.on('close', () => {
    if (streaming) {
      streamingConnections = Math.max(0, streamingConnections - 1);
      if (player) streamingSlots[player] = Math.max(0, streamingSlots[player] - 1);
    }
    console.log('\n[phone] disconnected');
    broadcast(status());
  });
});

const fmt = (v) => (v ?? 0).toFixed(2).padStart(7);
const round = (v) => (v === null || v === undefined ? null : Math.round(v * 1e4) / 1e4);

if (LOG) {
  await mkdir(path.dirname(LOG), { recursive: true });
  logStream = createWriteStream(LOG, { flags: 'a' });
  logStream.on('error', (e) => console.error('[log]', e.message));
  logStream.write('t,x,y,z,ax,ay,az,fx,fy,fz,fmag,hw_weight,settled\n');
  const flush = () => logStream.end(() => process.exit(0));
  process.on('SIGINT', flush);
  process.on('SIGTERM', flush);
}

// A busy port is the most likely startup failure — usually a previous run that
// was never stopped. Report it as an instruction rather than a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error('  An earlier copy of this server is probably still running.\n');
    console.error('  Stop it:');
    console.error(`      Get-NetTCPConnection -State Listen -LocalPort ${PORT} \``);
    console.error('        | Select-Object -ExpandProperty OwningProcess -Unique `');
    console.error('        | ForEach-Object { Stop-Process -Id $_ -Force }\n');
    console.error('  Or just use a different port:');
    console.error(`      $env:PORT=${PORT + 1}; npm run accel\n`);
  } else {
    console.error(`\n  Server failed to start: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', async () => {
  const primary = nics.find((n) => !n.virtual) || nics[0];

  if (!primary) {
    console.error('\nNo network connection found — this machine has no usable');
    console.error('LAN address, so the phone has nothing to connect to.\n');
    return;
  }

  if (regenerated && previous) {
    console.log('\nYour IP address changed since the last run, so the URL below');
    console.log(`is new. (previously: ${previous})`);
  }

  console.log('\n  Open this on the PHONE, on the same WiFi:\n');
  console.log(`      https://${primary.address}:${PORT}/`);
  console.log(`      (interface: ${primary.iface})\n`);

  const others = nics.filter((n) => n !== primary);
  if (others.length) {
    console.log('  If that one does not load, the fallbacks are:');
    for (const n of others) {
      console.log(`      https://${n.address}:${PORT}/   [${n.iface}]`);
    }
    console.log('');
  }

  console.log(`  Boxing game on this laptop:   https://localhost:${PORT}/boxing.html`);
  console.log(`  Live readout on this laptop:  https://localhost:${PORT}/monitor.html`);
  if (LOG) console.log(`  Logging CSV to ${LOG}`);
  console.log('\n  Both devices will show a certificate warning. Accept it — the');
  console.log('  cert is self-signed and never leaves this machine.\n');

  await selfTest(primary, PORT);
});

// Proves the server is reachable over the LAN interface itself, so a failure
// gets attributed to the network rather than blamed on the phone.
async function selfTest(primary, port) {
  if (await probe(primary.address, port)) {
    console.log(`  [check] ${primary.address}:${port} is reachable — server side is good.`);
    console.log('          If the phone still cannot load it, the network is blocking');
    console.log('          device-to-device traffic.\n');
  } else {
    console.log(`  [check] FAILED to reach ${primary.address}:${port} from this machine.`);
    console.log('          Inbound connections are being dropped, almost always by');
    console.log('          Windows Firewall. Allow it from an elevated PowerShell:\n');
    console.log('          New-NetFirewallRule -DisplayName "Accel Bridge" `');
    console.log(`            -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow\n`);
  }

  // Guest and corporate WiFi commonly enable client isolation, which blocks
  // phone->laptop traffic no matter how the server is configured.
  if (/^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(primary.address)) {
    console.log('  [note] This looks like a guest or corporate network. Those often');
    console.log('         stop devices talking to each other (client isolation). If');
    console.log('         the phone times out, use a home WiFi or a phone hotspot.\n');
  }
}

function probe(host, port) {
  return new Promise((resolve) => {
    // No servername: RFC 6066 forbids SNI for IP literals and Node warns.
    const socket = connect({ host, port, rejectUnauthorized: false });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(4000);
    socket.on('secureConnect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}
