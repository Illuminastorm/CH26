import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureCert } from '../server/cert.mjs';
import { lanAddresses } from '../server/net.mjs';
import { RoomStore } from './room-store.mjs';
import { attachSecureWebSocket } from './secure-ws.mjs';

const BASE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(BASE, 'public');
const DEFAULT_PORT = Number(process.env.SECURE_ARCADE_PORT || 9443);
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const CLOSE_HANDSHAKE_TIMEOUT_MS = 2_000;
const MAX_SAMPLE_RATE_PER_SECOND = 90;
const ROOM_ID_PATTERN = /^GO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const STATIC_FILES = new Map([
  ['/', { file: 'landing.html', type: 'text/html; charset=utf-8' }],
  ['/arcade.css', { file: 'arcade.css', type: 'text/css; charset=utf-8' }],
  ['/landing.js', { file: 'landing.js', type: 'text/javascript; charset=utf-8' }],
  ['/lobby.js', { file: 'lobby.js', type: 'text/javascript; charset=utf-8' }],
  ['/game.js', { file: 'game.js', type: 'text/javascript; charset=utf-8' }],
  ['/phone.js', { file: 'phone.js', type: 'text/javascript; charset=utf-8' }],
  ['/host-expired.html', { file: 'host-expired.html', type: 'text/html; charset=utf-8' }],
  ['/link-expired.html', { file: 'link-expired.html', type: 'text/html; charset=utf-8' }],
]);

function formatOrigin(hostname, port) {
  return `https://${hostname}${port === 443 ? '' : `:${port}`}`;
}

function parseConfiguredOrigins(value) {
  if (!value) return [];
  return value.split(',').map((item) => {
    const trimmed = item.trim();
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.origin !== trimmed) throw new Error('ALLOWED_ORIGINS entries must be exact HTTPS origins');
    return parsed.origin;
  });
}

export function createAllowedOrigins(port, additionalOrigins = []) {
  const origins = new Set([
    formatOrigin('localhost', port),
    formatOrigin('127.0.0.1', port),
    formatOrigin('[::1]', port),
  ]);
  for (const nic of lanAddresses()) origins.add(formatOrigin(nic.address, port));
  for (const origin of additionalOrigins) origins.add(origin);
  return origins;
}

function requestOrigin(req, allowedOrigins) {
  const host = req.headers.host;
  if (typeof host !== 'string') return null;
  try {
    const origin = new URL(`https://${host}`).origin;
    return allowedOrigins.has(origin) ? origin : null;
  } catch {
    return null;
  }
}

function parseLocalRequestUrl(req, origin) {
  // Node accepts absolute-form request targets on an HTTP server. This bridge
  // only exposes canonical origin-form routes, so do not let an authority,
  // dot segment, or backslash embedded in a request target influence route
  // parsing or path checks after URL normalization.
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) return null;
  const pathEnd = req.url.search(/[?#]/);
  const rawPath = pathEnd < 0 ? req.url : req.url.slice(0, pathEnd);
  if (rawPath.includes('\\') || /(^|\/)(?:\.|%2e)(?:\.|%2e)?(?:\/|$)/i.test(rawPath)) return null;
  try {
    const url = new URL(req.url, origin);
    return url.origin === origin ? url : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const result = new Map();
  if (typeof header !== 'string') return result;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name && value && !result.has(name)) result.set(name, value);
  }
  return result;
}

function setSessionCookie(res, name, token, expiresAt) {
  const seconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  res.setHeader('Set-Cookie', `${name}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`);
}

function clearSessionCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

function setSecurityHeaders(res, origin) {
  const wsOrigin = origin.replace(/^https:/, 'wss:');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'accelerometer=(self), gyroscope=(), camera=(), microphone=()');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${wsOrigin}`,
  ].join('; '));
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function isSameOrigin(req, origin) {
  return typeof req.headers.origin === 'string' && req.headers.origin === origin;
}

function getSingleToken(url) {
  if (url.searchParams.getAll('token').length !== 1 || [...url.searchParams.keys()].some((key) => key !== 'token')) return null;
  const token = url.searchParams.get('token');
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(token) ? token : null;
}

function hostCookieName(roomId) {
  return `__Host-go_arcade_host_${roomId}`;
}

function phoneCookieName(roomId, player) {
  return `__Host-go_arcade_phone_${roomId}_${player}`;
}

function hasExactQuery(url, names) {
  const keys = [...url.searchParams.keys()];
  return keys.length === names.length && names.every((name) => url.searchParams.getAll(name).length === 1);
}

function hostRouteContext(url) {
  if (!hasExactQuery(url, ['room'])) return null;
  const roomId = url.searchParams.get('room');
  return ROOM_ID_PATTERN.test(roomId || '') ? { roomId } : null;
}

function phoneRouteContext(url) {
  if (!hasExactQuery(url, ['room', 'player'])) return null;
  const roomId = url.searchParams.get('room');
  const player = Number(url.searchParams.get('player'));
  return ROOM_ID_PATTERN.test(roomId || '') && (player === 1 || player === 2) ? { roomId, player } : null;
}

function roomQuery(roomId) {
  return `room=${encodeURIComponent(roomId)}`;
}

function phoneQuery(roomId, player) {
  return `${roomQuery(roomId)}&player=${player}`;
}

async function readJson(req, maxBytes = 1024) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function makeRateGuard(limit, windowMs) {
  const frames = [];
  return () => {
    const now = Date.now();
    while (frames.length && frames[0] <= now - windowMs) frames.shift();
    if (frames.length >= limit) return false;
    frames.push(now);
    return true;
  };
}

function validSensorValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 200;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

function parsePhoneMessage(text) {
  let message;
  try { message = JSON.parse(text); } catch { return null; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.type === 'stream' && typeof message.active === 'boolean') {
    return { type: 'stream', active: message.active };
  }
  if (message.type !== 'sample') return null;
  if (!validSensorValue(message.x) || !validSensorValue(message.y) || !validSensorValue(message.z)) return null;
  const sample = {
    type: 'sample',
    x: round(message.x),
    y: round(message.y),
    z: round(message.z),
  };
  for (const key of ['ax', 'ay', 'az']) {
    if (message[key] === undefined || message[key] === null) continue;
    if (!validSensorValue(message[key])) return null;
    sample[key] = round(message[key]);
  }
  return sample;
}

function playerState(record, player) {
  const sockets = [...record.phones.values()].filter((ws) => ws.player === player && ws.open);
  return {
    connected: sockets.length > 0,
    streaming: sockets.some((ws) => ws.streaming),
  };
}

export function createSecureArcadeServer({
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  additionalOrigins = parseConfiguredOrigins(process.env.ALLOWED_ORIGINS),
  store = new RoomStore(),
  certDirectory = path.join(BASE, 'certs'),
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  closeHandshakeTimeoutMs = CLOSE_HANDSHAKE_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
  if (!Number.isInteger(heartbeatIntervalMs) || !Number.isInteger(heartbeatTimeoutMs) || heartbeatIntervalMs < 1 || heartbeatTimeoutMs <= heartbeatIntervalMs) {
    throw new Error('heartbeat timeout must be greater than the heartbeat interval');
  }
  if (!Number.isInteger(closeHandshakeTimeoutMs) || closeHandshakeTimeoutMs < 1 || closeHandshakeTimeoutMs > 60_000) {
    throw new Error('close handshake timeout must be between 1 and 60000 milliseconds');
  }
  const { key, cert, nics } = ensureCert(certDirectory);
  const allowedOrigins = createAllowedOrigins(port, additionalOrigins);
  const primaryNic = nics.find((nic) => !nic.virtual) || nics[0];
  // Keep the host console and every issued phone link on one LAN-reachable
  // origin. A laptop may open localhost initially, but a phone's localhost is
  // its own device, not this bridge.
  const publicOrigin = primaryNic ? formatOrigin(primaryNic.address, port) : formatOrigin('localhost', port);
  const roomSockets = new Map();
  const liveSockets = new Set();
  const creationAttempts = new Map();
  const sessionRateGuards = new Map();

  function socketsFor(room) {
    let record = roomSockets.get(room.id);
    if (!record) {
      record = { monitors: new Set(), phones: new Map() };
      roomSockets.set(room.id, record);
    }
    return record;
  }

  function hasActiveConnections(room) {
    const record = roomSockets.get(room.id);
    return Boolean(record && (record.monitors.size || record.phones.size));
  }

  function roomStatus(room) {
    const record = roomSockets.get(room.id) || { monitors: new Set(), phones: new Map() };
    const players = [1, 2].map((player) => playerState(record, player));
    return {
      type: 'status',
      roomId: room.id,
      connected: players.some((player) => player.streaming),
      streamCount: players.filter((player) => player.streaming).length,
      players,
    };
  }

  function broadcastStatus(room) {
    if (room.closed) return;
    broadcastToMonitors(room, roomStatus(room));
  }

  function broadcastToMonitors(room, payload) {
    if (room.closed) return;
    const record = roomSockets.get(room.id);
    if (!record) return;
    const message = JSON.stringify(payload);
    for (const ws of [...record.monitors]) {
      if (!ws.open || !ws.sendText(message)) record.monitors.delete(ws);
    }
  }

  function closeRoomConnections(room, code = 1001, reason = 'session ended') {
    const record = roomSockets.get(room.id);
    if (!record) return;
    const sockets = new Set([...record.monitors, ...record.phones.values()]);
    roomSockets.delete(room.id);
    for (const ws of sockets) ws.close(code, reason);
  }

  function closePhoneSessions(room, sessionHashes) {
    const record = roomSockets.get(room.id);
    for (const sessionHash of sessionHashes) {
      sessionRateGuards.delete(`phone:${sessionHash}`);
      if (!record) continue;
      const ws = record.phones.get(sessionHash);
      if (ws) ws.close(1008, 'new player link accepted');
    }
  }

  function acceptRoomCreation(ip) {
    const now = Date.now();
    const current = creationAttempts.get(ip);
    if (!current || now >= current.resetAt) {
      creationAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    current.count += 1;
    return current.count <= 5;
  }

  function rateGuardFor(context) {
    const key = `${context.role}:${context.sessionHash}`;
    const existing = sessionRateGuards.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.allow;
    const limit = context.role === 'phone' ? MAX_SAMPLE_RATE_PER_SECOND : 30;
    const allow = makeRateGuard(limit, 1_000);
    sessionRateGuards.set(key, { allow, roomId: context.room.id, expiresAt: context.expiresAt });
    return allow;
  }

  async function serveStatic(res, entry) {
    try {
      const body = await readFile(path.join(PUBLIC, entry.file));
      res.writeHead(200, {
        'Content-Type': entry.type,
        'Content-Length': body.length,
      });
      res.end(body);
    } catch {
      sendText(res, 500, 'asset unavailable');
    }
  }

  async function requestHandler(req, res) {
    const origin = requestOrigin(req, allowedOrigins);
    if (!origin) {
      setSecurityHeaders(res, formatOrigin('localhost', port));
      sendText(res, 421, 'untrusted host');
      return;
    }
    setSecurityHeaders(res, origin);

    const url = parseLocalRequestUrl(req, origin);
    if (!url) {
      sendText(res, 400, 'bad request');
      return;
    }
    const pathName = url.pathname;
    const cookies = parseCookies(req.headers.cookie);

    if (req.method === 'GET' && pathName === '/host') {
      const token = getSingleToken(url);
      const claimed = token && store.claimHost(token);
      if (!claimed) {
        redirect(res, '/host-expired.html');
        return;
      }
      setSessionCookie(res, hostCookieName(claimed.room.id), claimed.sessionToken, claimed.expiresAt);
      redirect(res, `/lobby.html?${roomQuery(claimed.room.id)}`);
      return;
    }

    if (req.method === 'GET' && pathName === '/join') {
      const token = getSingleToken(url);
      const claimed = token && store.claimPhone(token);
      if (!claimed) {
        redirect(res, '/link-expired.html');
        return;
      }
      closePhoneSessions(claimed.room, claimed.invalidatedSessionHashes);
      setSessionCookie(res, phoneCookieName(claimed.room.id, claimed.player), claimed.sessionToken, claimed.expiresAt);
      redirect(res, `/phone.html?${phoneQuery(claimed.room.id, claimed.player)}`);
      return;
    }

    const hostRoute = hostRouteContext(url);
    const phoneRoute = phoneRouteContext(url);
    const hostToken = hostRoute && cookies.get(hostCookieName(hostRoute.roomId));
    const phoneToken = phoneRoute && cookies.get(phoneCookieName(phoneRoute.roomId, phoneRoute.player));
    const rawHost = hostToken && store.hostContext(hostToken);
    const rawPhone = phoneToken && store.phoneContext(phoneToken);
    const host = rawHost && rawHost.room.id === hostRoute?.roomId ? rawHost : null;
    const phone = rawPhone && rawPhone.room.id === phoneRoute?.roomId && rawPhone.player === phoneRoute?.player ? rawPhone : null;
    const hostPage = pathName === '/lobby.html' || pathName === '/game.html';
    const phonePage = pathName === '/phone.html';
    if (req.method === 'GET' && hostPage && !host) {
      if (hostRoute) clearSessionCookie(res, hostCookieName(hostRoute.roomId));
      redirect(res, '/');
      return;
    }
    if (req.method === 'GET' && phonePage && !phone) {
      if (phoneRoute) clearSessionCookie(res, phoneCookieName(phoneRoute.roomId, phoneRoute.player));
      redirect(res, '/link-expired.html');
      return;
    }

    if (req.method === 'GET' && hostPage) {
      await serveStatic(res, { file: pathName.slice(1), type: 'text/html; charset=utf-8' });
      return;
    }
    if (req.method === 'GET' && phonePage) {
      await serveStatic(res, { file: 'phone.html', type: 'text/html; charset=utf-8' });
      return;
    }

    if (req.method === 'GET' && pathName === '/api/session') {
      if (!host) {
        sendJson(res, 401, { error: 'host session required' });
        return;
      }
      const record = roomSockets.get(host.room.id) || { monitors: new Set(), phones: new Map() };
      const invites = [1, 2].map((player) => {
        const inviteHash = host.room.inviteByPlayer.get(player);
        const invite = inviteHash && store.phoneInvites.get(inviteHash);
        return { player, active: Boolean(invite), expiresAt: invite?.expiresAt || null };
      });
      sendJson(res, 200, {
        roomId: host.room.id,
        players: [1, 2].map((player) => ({ player, ...playerState(record, player) })),
        invites,
      });
      return;
    }

    if (req.method === 'GET' && pathName === '/api/phone-session') {
      if (!phone) {
        sendJson(res, 401, { error: 'phone session required' });
        return;
      }
      sendJson(res, 200, { roomId: phone.room.id, player: phone.player });
      return;
    }

    if (req.method === 'POST' && pathName === '/api/rooms') {
      if (!isSameOrigin(req, origin)) {
        sendJson(res, 403, { error: 'same-origin request required' });
        return;
      }
      const ip = req.socket.remoteAddress || 'unknown';
      if (!acceptRoomCreation(ip)) {
        sendJson(res, 429, { error: 'try again shortly' });
        return;
      }
      const created = store.createRoom();
      sendJson(res, 201, {
        hostUrl: `${publicOrigin}/host?token=${encodeURIComponent(created.bootstrapToken)}`,
      });
      return;
    }

    if (req.method === 'POST' && pathName === '/api/invites') {
      if (!isSameOrigin(req, origin) || !host) {
        sendJson(res, host ? 403 : 401, { error: 'host session required' });
        return;
      }
      try {
        const body = await readJson(req);
        const player = Number(body.player);
        const invite = store.issueInvite(hostToken, player);
        if (!invite) {
          sendJson(res, 400, { error: 'invalid player slot' });
          return;
        }
        sendJson(res, 201, {
          player,
          expiresAt: invite.expiresAt,
          joinUrl: `${publicOrigin}/join?token=${encodeURIComponent(invite.inviteToken)}`,
        });
      } catch {
        sendJson(res, 400, { error: 'invalid request' });
      }
      return;
    }

    if (req.method === 'POST' && pathName === '/api/close') {
      if (!isSameOrigin(req, origin) || !host) {
        sendJson(res, host ? 403 : 401, { error: 'host session required' });
        return;
      }
      const closed = store.closeRoom(hostToken);
      if (closed) closeRoomConnections(closed);
      clearSessionCookie(res, hostCookieName(host.room.id));
      sendJson(res, 200, { closed: true });
      return;
    }

    if (req.method === 'GET' && STATIC_FILES.has(pathName)) {
      await serveStatic(res, STATIC_FILES.get(pathName));
      return;
    }

    sendText(res, 404, 'not found');
  }

  const server = createServer({ key, cert }, (req, res) => {
    requestHandler(req, res).catch(() => {
      if (!res.headersSent) {
        const origin = requestOrigin(req, allowedOrigins) || formatOrigin('localhost', port);
        setSecurityHeaders(res, origin);
        sendText(res, 500, 'request failed');
      } else {
        res.end();
      }
    });
  });

  function authorizeUpgrade(req) {
    const origin = requestOrigin(req, allowedOrigins);
    if (!origin || req.headers.origin !== origin) return { ok: false, status: 403, reason: 'unexpected origin' };

    const url = parseLocalRequestUrl(req, origin);
    if (!url) return { ok: false, status: 404, reason: 'unexpected path' };
    if (url.pathname !== '/ws/phone' && url.pathname !== '/ws/monitor') {
      return { ok: false, status: 404, reason: 'unexpected path' };
    }
    const cookies = parseCookies(req.headers.cookie);
    if (url.pathname === '/ws/phone') {
      const route = phoneRouteContext(url);
      if (!route) return { ok: false, status: 404, reason: 'unexpected path' };
      const token = cookies.get(phoneCookieName(route.roomId, route.player));
      const phone = token && store.phoneContext(token);
      if (!phone || phone.room.id !== route.roomId || phone.player !== route.player) {
        return { ok: false, status: 401, reason: 'phone session required' };
      }
      return { ok: true, context: { role: 'phone', token, ...phone } };
    }
    const route = hostRouteContext(url);
    if (!route) return { ok: false, status: 404, reason: 'unexpected path' };
    const token = cookies.get(hostCookieName(route.roomId));
    const hostContext = token && store.hostContext(token);
    if (!hostContext || hostContext.room.id !== route.roomId) return { ok: false, status: 401, reason: 'host session required' };
    return { ok: true, context: { role: 'monitor', token, ...hostContext } };
  }

  function attachConnection(ws, context) {
    const { room } = context;
    const record = socketsFor(room);
    ws.role = context.role;
    ws.room = room;
    ws.sessionToken = context.token;
    ws.sessionHash = context.sessionHash;
    ws.player = context.player || null;
    ws.streaming = false;
    ws.lastPongAt = Date.now();
    ws.frameAllowed = rateGuardFor(context);
    liveSockets.add(ws);

    // Register teardown before the connection is exposed to room state or a
    // first status frame is sent, so a write failure cannot strand it.
    ws.on('close', () => {
      liveSockets.delete(ws);
      const activeRecord = roomSockets.get(room.id);
      if (!activeRecord) return;
      if (ws.role === 'monitor') activeRecord.monitors.delete(ws);
      else if (activeRecord.phones.get(ws.sessionHash) === ws) activeRecord.phones.delete(ws.sessionHash);
      if (!activeRecord.monitors.size && !activeRecord.phones.size) roomSockets.delete(room.id);
      if (!room.closed) {
        store.touch(room);
        broadcastStatus(room);
      }
    });

    ws.on('pong', () => { ws.lastPongAt = Date.now(); });
    ws.on('frame', () => {
      if (ws.frameAllowed()) return true;
      ws.close(1008, 'message rate limit');
      return false;
    });
    ws.on('message', (text) => {
      if (ws.role !== 'phone') {
        ws.close(1008, 'monitor is read only');
        return;
      }
      const message = parsePhoneMessage(text);
      if (!message) {
        ws.close(1008, 'invalid sensor message');
        return;
      }
      if (message.type === 'stream') {
        if (ws.streaming !== message.active) {
          ws.streaming = message.active;
          store.touch(room);
          broadcastStatus(room);
        }
        return;
      }
      if (!ws.streaming) {
        ws.close(1008, 'stream not enabled');
        return;
      }
      store.touch(room);
      // The sample is immediately fan-out data only. It is never stored,
      // replayed to a later monitor, printed, or written to disk.
      broadcastToMonitors(room, { ...message, player: ws.player });
    });

    if (context.role === 'monitor') {
      record.monitors.add(ws);
      ws.sendText(JSON.stringify(roomStatus(room)));
    } else {
      const prior = record.phones.get(context.sessionHash);
      if (prior && prior !== ws) prior.close(1008, 'reconnected elsewhere');
      record.phones.set(context.sessionHash, ws);
      broadcastStatus(room);
    }
  }

  attachSecureWebSocket(server, {
    authorize: authorizeUpgrade,
    onConnection: attachConnection,
    closeHandshakeTimeoutMs,
  });

  const heartbeat = setInterval(() => {
    for (const ws of [...liveSockets]) {
      const stillAuthorized = ws.role === 'phone' ? store.phoneContext(ws.sessionToken) : store.hostContext(ws.sessionToken);
      if (!stillAuthorized || stillAuthorized.room !== ws.room || Date.now() - ws.lastPongAt > heartbeatTimeoutMs) {
        ws.terminate();
        continue;
      }
      ws.ping();
    }
    for (const removed of store.sweep({ hasActiveConnections })) closeRoomConnections(removed);
    const now = Date.now();
    for (const [ip, attempt] of creationAttempts) {
      if (attempt.resetAt <= now) creationAttempts.delete(ip);
    }
    for (const [key, rate] of sessionRateGuards) {
      if (rate.expiresAt <= now || !store.rooms.has(rate.roomId)) sessionRateGuards.delete(key);
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  return {
    server,
    store,
    allowedOrigins,
    publicOrigin,
    nics,
    async start() {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    async close() {
      clearInterval(heartbeat);
      for (const ws of [...liveSockets]) ws.terminate();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const app = createSecureArcadeServer();
  try {
    await app.start();
    const port = DEFAULT_PORT;
    console.log('Secure arcade bridge is ready.');
    console.log(`Open the host console and phone links at: ${app.publicOrigin}/`);
    if (!app.nics.length) console.log(`No LAN address was found. Local fallback: https://localhost:${port}/`);
    console.log('Sensor samples stay in memory only for their active room and are not logged.');
  } catch (error) {
    console.error(`Secure arcade bridge could not start: ${error.code || error.message}`);
    process.exitCode = 1;
  }
}
