// Minimal RFC 6455 WebSocket server. Text frames only, no extensions.
// Enough for one-way sensor streaming + small JSON control messages.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function attachWebSocket(httpServer, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    onConnection(new WSConnection(socket, req));
  });
}

class WSConnection {
  constructor(socket, req) {
    this.socket = socket;
    this.url = req.url;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.handlers = { message: [], close: [] };

    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.#drain();
    });
    const die = () => this.#die();
    socket.on('close', die);
    socket.on('error', die);
  }

  on(event, fn) { this.handlers[event]?.push(fn); return this; }

  #emit(event, arg) { for (const fn of this.handlers[event] || []) fn(arg); }

  #die() {
    if (!this.open) return;
    this.open = false;
    this.#emit('close');
  }

  #drain() {
    for (;;) {
      const frame = decodeFrame(this.buf);
      if (!frame) return;
      this.buf = this.buf.subarray(frame.size);

      if (frame.opcode === 0x8) { this.close(); return; }       // close
      if (frame.opcode === 0x9) { this.#pong(frame.payload); continue; } // ping
      if (frame.opcode === 0x1) this.#emit('message', frame.payload.toString('utf8'));
      // binary (0x2) and continuation frames are ignored by design
    }
  }

  #pong(payload) { if (this.open) this.socket.write(encodeFrame(payload, 0xA)); }

  send(text) {
    if (!this.open) return false;
    return this.socket.write(encodeFrame(Buffer.from(text, 'utf8'), 0x1));
  }

  close() {
    if (!this.open) return;
    try { this.socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
    this.socket.end();
    this.#die();
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
    if (big > 1_000_000n) return null; // refuse absurd frames
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
