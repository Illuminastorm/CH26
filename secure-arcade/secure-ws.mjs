import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const MAX_INBOUND_MESSAGE_BYTES = 4 * 1024;
export const MAX_INBOUND_BUFFER_BYTES = 8 * 1024;
export const MAX_OUTBOUND_BUFFER_BYTES = 64 * 1024;
const REJECTED_UPGRADE_CLOSE_TIMEOUT_MS = 1_000;

function includesToken(value, expected) {
  return typeof value === 'string' && value
    .split(',')
    .some((part) => part.trim().toLowerCase() === expected);
}

function badUpgrade(reason, status = 400) {
  return { ok: false, status, reason };
}

export function validateWebSocketUpgrade(req) {
  if (req.method !== 'GET') return badUpgrade('bad request method');
  if (!includesToken(req.headers.upgrade, 'websocket')) return badUpgrade('websocket upgrade required');
  if (!includesToken(req.headers.connection, 'upgrade')) return badUpgrade('connection upgrade required');
  if (req.headers['sec-websocket-version'] !== '13') return badUpgrade('unsupported websocket version');

  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') return badUpgrade('websocket key required');
  try {
    // RFC 6455 requires a canonical Base64 encoding of exactly 16 random
    // bytes. Buffer.from(..., 'base64') deliberately accepts malformed input,
    // so check both the grammar and its canonical round trip.
    if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return badUpgrade('invalid websocket key');
    const decoded = Buffer.from(key, 'base64');
    if (decoded.length !== 16 || decoded.toString('base64') !== key) return badUpgrade('invalid websocket key');
  } catch {
    return badUpgrade('invalid websocket key');
  }
  return { ok: true };
}

export function rejectUpgrade(socket, status, reason) {
  const label = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
  }[status] || 'Bad Request';
  // An HTTP rejection is not a WebSocket yet, so it has no connection object
  // or heartbeat to supervise it. Bound its transport lifetime explicitly:
  // `end()` lets normal clients read the response, while the timer prevents a
  // hostile half-open TLS peer from occupying a descriptor indefinitely.
  let closeTimer;
  const clearCloseTimer = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };
  const forceClose = () => {
    clearCloseTimer();
    try { socket.destroy(); } catch {}
  };
  socket.once('close', clearCloseTimer);
  socket.once('error', clearCloseTimer);
  closeTimer = setTimeout(forceClose, REJECTED_UPGRADE_CLOSE_TIMEOUT_MS);
  closeTimer.unref?.();
  try {
    socket.end(
      `HTTP/1.1 ${status} ${label}\r\n` +
      'Connection: close\r\n' +
      'Cache-Control: no-store\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
    );
  } catch {
    forceClose();
  }
}

/**
 * Attaches a deliberately narrow RFC 6455 server. The caller authenticates
 * request paths/origins/cookies before this function sends a 101 response.
 */
export function attachSecureWebSocket(httpServer, {
  authorize,
  onConnection,
  maxInboundBytes = MAX_INBOUND_MESSAGE_BYTES,
  maxInboundBufferBytes = MAX_INBOUND_BUFFER_BYTES,
  maxOutboundBufferBytes = MAX_OUTBOUND_BUFFER_BYTES,
  idleSocketTimeoutMs = 70_000,
  closeHandshakeTimeoutMs = 2_000,
}) {
  httpServer.on('upgrade', (req, socket, head) => {
    const protocol = validateWebSocketUpgrade(req);
    if (!protocol.ok) {
      rejectUpgrade(socket, protocol.status, protocol.reason);
      return;
    }

    const auth = authorize(req);
    if (!auth?.ok) {
      rejectUpgrade(socket, auth?.status || 403, auth?.reason || 'forbidden');
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      'Cache-Control: no-store\r\n\r\n',
    );
    socket.setNoDelay(true);
    const ws = new SecureWebSocketConnection(socket, req, {
      maxInboundBytes,
      maxInboundBufferBytes,
      maxOutboundBufferBytes,
      idleSocketTimeoutMs,
      closeHandshakeTimeoutMs,
    });
    onConnection(ws, auth.context);
    if (head?.length) ws.receive(head);
  });
}

export class SecureWebSocketConnection {
  constructor(socket, req, {
    maxInboundBytes = MAX_INBOUND_MESSAGE_BYTES,
    maxInboundBufferBytes = MAX_INBOUND_BUFFER_BYTES,
    maxOutboundBufferBytes = MAX_OUTBOUND_BUFFER_BYTES,
    idleSocketTimeoutMs = 70_000,
    closeHandshakeTimeoutMs = 2_000,
  } = {}) {
    this.socket = socket;
    this.url = req.url;
    this.open = true;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.maxInboundBytes = maxInboundBytes;
    this.maxInboundBufferBytes = maxInboundBufferBytes;
    this.maxOutboundBufferBytes = maxOutboundBufferBytes;
    this.closeHandshakeTimeoutMs = closeHandshakeTimeoutMs;
    this.closeTimer = null;
    this.handlers = { close: [], frame: [], message: [], pong: [] };

    socket.setTimeout(idleSocketTimeoutMs, () => this.terminate());
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('close', () => this.#die());
    socket.on('error', () => this.#die());
  }

  on(event, handler) {
    this.handlers[event]?.push(handler);
    return this;
  }

  receive(chunk) {
    if (!this.open) return;
    if (this.buffer.length + chunk.length > this.maxInboundBufferBytes) {
      this.close(1009, 'frame buffer limit');
      return;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    this.#drain();
  }

  sendText(text) {
    if (!this.open || typeof text !== 'string') return false;
    const payload = Buffer.from(text, 'utf8');
    if (payload.length > this.maxInboundBytes || this.socket.writableLength > this.maxOutboundBufferBytes) {
      this.close(1013, 'slow consumer');
      return false;
    }
    try {
      const accepted = this.socket.write(encodeFrame(payload, 0x1));
      if (!accepted && this.socket.writableLength > 0) this.close(1013, 'slow consumer');
      return accepted;
    } catch {
      this.terminate();
      return false;
    }
  }

  ping() {
    return this.#sendControl(Buffer.alloc(0), 0x9);
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    // Stop all application work immediately, but keep the transport tracked
    // until the peer closes or the bounded close handshake expires. Calling
    // #die() here used to remove this socket from the server's cleanup set
    // while a hostile peer could keep its TLS connection half-open.
    this.open = false;
    this.buffer = Buffer.alloc(0);
    const safeReason = Buffer.from(String(reason), 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + safeReason.length);
    payload.writeUInt16BE(code, 0);
    safeReason.copy(payload, 2);
    try { this.socket.write(encodeFrame(payload, 0x8)); } catch {}
    try { this.socket.end(); } catch {
      this.terminate();
      return;
    }
    this.#armCloseTimer();
    if (this.socket.destroyed) this.#die();
  }

  terminate() {
    if (this.closed) return;
    try { this.socket.destroy(); } catch {}
    this.#die();
  }

  #drain() {
    while (this.open) {
      const parsed = decodeClientFrame(this.buffer, this.maxInboundBytes);
      if (!parsed) return;
      if (parsed.error) {
        this.close(parsed.code, parsed.reason);
        return;
      }
      // Do not leave a zero-length (or partial-next-frame) view backed by a
      // prior sensor frame. A copy of only unread bytes lets the processed
      // payload become collectible as soon as this iteration completes.
      const remaining = this.buffer.subarray(parsed.size);
      this.buffer = remaining.length ? Buffer.from(remaining) : Buffer.alloc(0);
      const { opcode, payload } = parsed;
      // Count every client frame, including control frames, before processing
      // it. This prevents a Ping/Pong flood from bypassing application-level
      // sensor rate limits or creating unbounded server Pong work.
      if (!this.#emit('frame', { opcode, payloadLength: payload.length }) || !this.open) return;
      if (opcode === 0x8) {
        this.close(1000, '');
        return;
      }
      if (opcode === 0x9) {
        this.#sendControl(payload, 0xA);
        continue;
      }
      if (opcode === 0xA) {
        this.#emit('pong');
        continue;
      }
      if (opcode === 0x1) {
        if (!isUtf8(payload)) {
          this.close(1007, 'invalid utf8');
          return;
        }
        this.#emit('message', payload.toString('utf8'));
      }
    }
  }

  #sendControl(payload, opcode) {
    if (!this.open || payload.length > 125) return false;
    try {
      const accepted = this.socket.write(encodeFrame(payload, opcode));
      if (!accepted && this.socket.writableLength > this.maxOutboundBufferBytes) this.terminate();
      return accepted;
    } catch {
      this.terminate();
      return false;
    }
  }

  #emit(event, arg) {
    for (const handler of this.handlers[event] || []) {
      if (handler(arg) === false) return false;
    }
    return true;
  }

  #die() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.buffer = Buffer.alloc(0);
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    for (const handler of this.handlers.close) handler();
  }

  #armCloseTimer() {
    if (this.closed || this.closeTimer) return;
    this.closeTimer = setTimeout(() => this.terminate(), this.closeHandshakeTimeoutMs);
    this.closeTimer.unref?.();
  }
}

export function decodeClientFrame(buffer, maxPayloadBytes = MAX_INBOUND_MESSAGE_BYTES) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const rsv = first & 0x70;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (rsv) return protocolError('extensions are disabled');
  if (!fin) return protocolError('fragmented frames are disabled');
  if (!masked) return protocolError('client frames must be masked');
  if (![0x1, 0x8, 0x9, 0xA].includes(opcode)) {
    return { error: true, code: opcode === 0x2 ? 1003 : 1002, reason: 'unsupported frame type' };
  }

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const declared = buffer.readBigUInt64BE(offset);
    if (declared > BigInt(maxPayloadBytes)) return { error: true, code: 1009, reason: 'message too large' };
    length = Number(declared);
    offset += 8;
  }

  const isControl = opcode >= 0x8;
  if (isControl && length > 125) return protocolError('oversized control frame');
  if (!isControl && length > maxPayloadBytes) return { error: true, code: 1009, reason: 'message too large' };
  if (buffer.length < offset + 4) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  if (opcode === 0x8 && payload.length === 1) return protocolError('invalid close frame');
  return { opcode, payload, size: offset + length };
}

function protocolError(reason) {
  return { error: true, code: 1002, reason };
}

export function encodeFrame(payload, opcode) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}
