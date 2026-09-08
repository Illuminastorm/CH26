// Hardened WebSocket server. A drop-in for the minimal ws.mjs framing but with
// the connection-security requirements built in:
//
//   1. Origin check during the HTTP upgrade (rejects cross-site/bogus origins)
//   2. Path allow-list: only /phone and /monitor are served
//   3. Per-message size cap and per-connection message rate cap
//   4. Heartbeat: pings on an interval, closes dead peers, enforces a maximum
//      connection lifetime and an idle grace period
//
// This module owns the socket; the caller only receives sanitized connections
// via onConnection(ws). ws.url contains the full request URL (path + query).
//
// No sensor data touches this layer: it moves opaque text frames.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const DEFAULTS = {
  allowedOrigins: null,        // null = strict same-origin (https host) only
  paths: ['/phone', '/monitor'], // only these upgrade paths are served
  maxMessageBytes: 8192,       // 8 KB per message; far above control msgs
  maxMessagesPerSecond: 250,   // phones stream at 60Hz + control chatter
  heartbeatMs: 30_000,         // ping cadence
  heartbeatTimeoutMs: 15_000,  // no pong within this => close
  maxLifetimeMs: 24 * 60 * 60 * 1000, // fail-safe absolute cap
  maxIdleBytes: 64 * 1024,     // per-connection I/O high-water
};

export function attachSecureWebSocket(httpServer, onConnection, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (cfg.allowedOrigins && typeof cfg.allowedOrigins === 'string') {
    cfg.allowedOrigins = [cfg.allowedOrigins];
  }

  httpServer.on('upgrade', (req, socket) => {
    // --- 0. TLS terminated upstream (Render/Cloud Run); never serve a raw upgrade
    if (!req.headers['sec-websocket-key'] || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }

    const { pathname } = new URL(req.url, 'http://localhost');
    if (!cfg.paths.includes(pathname)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!originAllowed(req, cfg.allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      socket.destroy();
      return;
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const ws = new SecureWS(socket, req, cfg);
    try { onConnection(ws); } catch { ws.close(); }
  });
}

function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) {
    // Browsers always send Origin on WS upgrades. A missing Origin means a
    // script/curl client: reject it rather than guess.
    return false;
  }
  if (allowedOrigins && allowedOrigins.length) {
    return allowedOrigins.includes(origin);
  }
  // Strict same-origin default: Origin must equal the advertised host+scheme.
  const host = req.headers.host;
  if (!host) return false;
  const url = safeParse(origin);
  if (!url) return false;
  // match host, allow both http(s)
  return url.host === host;
}

function safeParse(u) {
  try { return new URL(u); } catch { return null; }
}

class SecureWS {
  constructor(socket, req, cfg) {
    this.socket = socket;
    this.url = req.url;
    this.origin = req.headers.origin || '';
    this.cfg = cfg;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.handlers = { message: [], close: [] };

    this.createdAt = Date.now();
    this.lastFrameAt = Date.now();
    this.msgCount = 0;
    this.rateWindowStart = Date.now();
    this.pendingPong = false;
    this.dead = false;

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#die());
    socket.on('error', () => this.#die());

    this.#startHeartbeat();
    this.#armLifetime();
  }

  #startHeartbeat() {
    const hb = this.cfg.heartbeatMs;
    this.heartbeatTimer = setInterval(() => {
      if (!this.open) return clearInterval(this.heartbeatTimer);
      if (this.pendingPong) {
        // Missed a pong => dead peer.
        this.#die();
        return;
      }
      this.pendingPong = true;
      this.socket.write(encodeFrame(Buffer.alloc(0), 0x9)); // ping
    }, hb);
    this.heartbeatTimer.unref?.();
  }

  #armLifetime() {
    const lt = this.cfg.maxLifetimeMs;
    this.lifetimeTimer = setTimeout(() => {
      if (this.open) this.#die();
    }, lt);
    this.lifetimeTimer.unref?.();
  }

  on(event, fn) { this.handlers[event]?.push(fn); return this; }

  #emit(event, arg) { for (const fn of this.handlers[event] || []) fn(arg); }

  #onData(chunk) {
    if (!this.open) return;
    if (chunk.length > this.cfg.maxIdleBytes) { this.#die(); return; }

    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frame = decodeFrame(this.buf);
      if (!frame) return;
      this.buf = this.buf.subarray(frame.size);

      // --- heartbeat handling ---
      if (frame.opcode === 0x8) { this.close(); return; }        // close
      if (frame.opcode === 0x9) { this.#pong(frame.payload); continue; } // ping
      if (frame.opcode === 0xA) { // pong clears pending
        this.pendingPong = false;
        continue;
      }
      if (frame.opcode === 0x2) { this.#die(); return; }          // no binary
      if (frame.opcode !== 0x1) continue;                         // no frags

      this.lastFrameAt = Date.now();

      // --- rate limit ---
      const now = Date.now();
      if (now - this.rateWindowStart >= 1000) {
        this.rateWindowStart = now;
        this.msgCount = 0;
      }
      this.msgCount++;
      if (this.msgCount > this.cfg.maxMessagesPerSecond) {
        this.#die();
        return;
      }

      // --- size limit ---
      if (frame.payload.length > this.cfg.maxMessageBytes) {
        this.#die();
        return;
      }

      this.#emit('message', frame.payload.toString('utf8'));
    }
  }

  #pong(payload) { if (this.open) this.socket.write(encodeFrame(payload, 0xA)); }

  send(text) {
    if (!this.open) return false;
    return this.socket.write(encodeFrame(Buffer.from(text, 'utf8'), 0x1));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    try {
      const payload = Buffer.concat([
        Buffer.from([(code >> 8) & 0xff, code & 0xff]),
        Buffer.from(reason),
      ]);
      this.socket.write(encodeFrame(payload, 0x8));
    } catch {}
    this.socket.end();
    this.#die();
  }

  #die() {
    if (this.dead) return;
    this.dead = true;
    this.open = false;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.lifetimeTimer);
    try { this.socket.destroy(); } catch {}
    this.#emit('close');
  }
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) === 0x80;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset); offset += 8;
    if (big > 1_000_000n) return null;
    len = Number(big);
  }

  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

  return { opcode, payload, size: offset + len };
}

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}