// Cloud Run entrypoint for the accelerometer bridge. Mirrors server/index.mjs
// but serves plain HTTP+WebSocket: Google's edge terminates TLS and provides
// wss:// and https:// automatically, so the self-signed LAN cert logic and the
// network self-test are not needed here.
//
// Cloud Run injects PORT (default 8080) and expects the process to listen on
// 0.0.0.0.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.mjs';
import { createFuser } from '../web/fuse.mjs';
import { createShakeGuard } from './shake-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;

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

const monitors = new Set();
let streamingConnections = 0;
let lastSample = null;
const streamingSlots = { 1: 0, 2: 0 };

function status() {
  return {
    type: 'status',
    connected: streamingConnections > 0,
    players: [1, 2].map((slot) => streamingSlots[slot] > 0),
    streamCount: streamingConnections,
    playerStreamCounts: [streamingSlots[1], streamingSlots[2]],
  };
}

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

  let player = null;
  let streaming = false;
  const fuse = createFuser();
  const shakeGuard = createShakeGuard();
  broadcast(status());

  ws.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.type === 'hello') {
      const requestedPlayer = Number(msg.player);
      if (streaming && player) streamingSlots[player]--;
      player = requestedPlayer === 1 || requestedPlayer === 2 ? requestedPlayer : null;
      if (streaming && player) streamingSlots[player]++;
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
    if (!streaming) return;

    const f = fuse(msg);
    msg.fx = round(f.x); msg.fy = round(f.y); msg.fz = round(f.z);
    msg.fmag = round(f.mag);
    msg.hwWeight = round(f.hwWeight);
    msg.gErr = round(f.gravityError);
    msg.settled = f.settled;
    msg.sources = f.sources;
    msg.player = player;
    const shake = shakeGuard({ t: msg.t, x: f.x, y: f.y, z: f.z });
    msg.shake = shake.blocked;
    msg.shakeDetected = shake.detected;
    lastSample = msg;

    broadcast(msg);
  });

  ws.on('close', () => {
    if (streaming) {
      streamingConnections = Math.max(0, streamingConnections - 1);
      if (player) streamingSlots[player] = Math.max(0, streamingSlots[player] - 1);
    }
    broadcast(status());
  });
});

const round = (v) => (v === null || v === undefined ? null : Math.round(v * 1e4) / 1e4);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`andescendants listening on :${PORT}`);
});
