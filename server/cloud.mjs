// Cloud entrypoint for the accelerometer bridge (hardened).
//
// Serves the static arcade pages, manages game sessions (a session isolates a
// game's phone streams from every other game), issues short-lived join tokens
// and QR links, and relays sensor frames only within the same session.
//
// Security & privacy posture:
//   - WebSocket upgrades validate Origin and only answer /phone and /monitor.
//   - Every connection must present a valid session id + join token.
//   - Per-message size caps, per-connection rate caps, heartbeat + dead-peer
//     cleanup (see server/ws-secure.mjs).
//   - Sensor payloads are never written to disk or logged. The only optional
//     storage is an explicit ENV-gated CSV sink (SENSOR_LOG) with a fixed,
//     documented retention window; it is OFF unless configured.
//
// Cloud Run / Render terminate TLS, so this listens on plain HTTP and the
// client uses wss:// via the upstream.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { attachSecureWebSocket } from './ws-secure.mjs';
import { createSessionStore } from './sessions.mjs';
import { createFuser } from '../web/fuse.mjs';
import { createShakeGuard } from './shake-guard.mjs';
import { maybeOpenSensorLog } from './sensor-log.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8080);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

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

const store = createSessionStore();
store.startSweep();

// Item 5: explicit storage. OFF by default (constructor with no args => null).
const sensorLog = maybeOpenSensorLog(process.env);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method?.toUpperCase() ?? 'GET';
  const p = url.pathname;
  // Scheme comes from the reverse proxy (Render/Cloud Run send
  // x-forwarded-proto: https) or the socket for a direct local connection.
  const proto = req.headers['x-forwarded-proto']?.split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  const base = PUBLIC_BASE || `${proto}://${req.headers.host}`;

  try {
    // --- API: create a game session ------------------------------------
    if (method === 'POST' && p === '/session') {
      const { id, code, token } = store.newSession();
      const joinUrl = `${base}/j/${code}`;
      const qrPng = await QRCode.toBuffer(joinUrl, { errorCorrectionLevel: 'M', width: 260, margin: 1 });
      const session = store.get(id);
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({
        id,
        code,
        token,
        url: `${base}/?session=${id}&token=${encodeURIComponent(token)}`,
        gameUrl: `${base}/boxing.html?session=${id}&token=${encodeURIComponent(token)}`,
        joinUrl,
        qrPng: `data:image/png;base64,${qrPng.toString('base64')}`,
        expiresAt: session.createdAt + 6 * 60 * 60 * 1000,
      }));
      return;
    }

    // --- API: phone joins by code ---------------------------------------
    // A phone that types/reads a code gets (once) a working session+token URL.
    if (method === 'GET' && p.startsWith('/j/')) {
      const code = p.slice(3).trim().toUpperCase();
      const joined = store.joinByCode(code);
      if (!joined) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Invalid or expired session code');
        return;
      }
      res.writeHead(302, {
        Location: `${base}/?session=${joined.id}&token=${encodeURIComponent(joined.token)}`,
      });
      res.end();
      return;
    }

    // --- static files ----------------------------------------------------
    let file = p === '/' ? '/index.html' : p;
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
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error');
  }
});

// --- WebSocket: secure, session-authenticated relay ------------------------
attachSecureWebSocket(server, (ws) => {
  const url = new URL(ws.url, 'http://localhost');
  const sessionId = url.searchParams.get('session');
  const token = url.searchParams.get('token');
  const session = store.authorize(sessionId, token);

  if (!session) {
    ws.close(4001, 'unauthorized');
    return;
  }

  const isMonitor = url.pathname === '/monitor';
  if (isMonitor) {
    store.addMonitor(session, ws);
    ws.on('close', () => store.removeMonitor(session, ws));
    const live = store.monitors(session).size;
    ws.send(JSON.stringify({ type: 'status', connected: store.phoneCount(session) > 0, players: [], streamCount: store.phoneCount(session), playerStreamCounts: [], liveMonitors: live }));
    return;
  }

  // phone connection
  let player = null;
  let streaming = false;
  const fuse = createFuser();
  const shakeGuard = createShakeGuard();
  store.addPhone(session, ws);

  const relays = () => ({
    type: 'status',
    connected: streaming,
    players: [],
    streamCount: store.phoneCount(session),
    playerStreamCounts: [],
  });

  ws.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.type === 'hello') {
      const requestedPlayer = Number(msg.player);
      player = requestedPlayer === 1 || requestedPlayer === 2 ? requestedPlayer : null;
      store.broadcast(session, JSON.stringify({ type: 'hello', ...msg, player }));
      store.broadcast(session, JSON.stringify(relays()));
      return;
    }

    if (msg.type === 'streaming') {
      const next = msg.active === true;
      if (streaming === next) return;
      streaming = next;
      store.broadcast(session, JSON.stringify(relays()));
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

    store.broadcast(session, JSON.stringify(msg));
    sensorLog?.write(msg);
  });

  ws.on('close', () => {
    store.removePhone(session, ws);
    store.broadcast(session, JSON.stringify(relays()));
  });
});

const round = (v) => (v === null || v === undefined ? null : Math.round(v * 1e4) / 1e4);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`andescendants listening on :${PORT}`);
  console.log(`allowed origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '(same-origin only)'}`);
  console.log(`sensor log: ${sensorLog ? sensorLog.describe() : 'OFF (no sensor data is stored or logged)'}`);
});