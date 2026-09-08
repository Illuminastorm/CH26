import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { RoomStore } from './room-store.mjs';
import {
  MAX_INBOUND_MESSAGE_BYTES,
  decodeClientFrame,
  validateWebSocketUpgrade,
} from './secure-ws.mjs';
import { createSecureArcadeServer } from './server.mjs';

function maskedFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const mask = Buffer.from([0x17, 0x3a, 0x55, 0x71]);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const encoded = Buffer.from(body);
  for (let index = 0; index < encoded.length; index++) encoded[index] ^= mask[index & 3];
  return Buffer.concat([header, mask, encoded]);
}

function serverFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      header = 10;
    }
    if (buffer.length - offset < header + length) break;
    frames.push({ opcode: first & 0x0f, payload: buffer.subarray(offset + header, offset + header + length) });
    offset += header + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

class RawWebSocket {
  constructor(socket, initial, autoPong = true) {
    this.socket = socket;
    this.autoPong = autoPong;
    this.buffer = initial;
    this.frames = [];
    this.closed = false;
    this.closeCode = null;
    this.waiters = [];
    socket.on('data', (chunk) => this.#consume(chunk));
    socket.on('close', () => {
      this.closed = true;
      this.#notify();
    });
    socket.on('error', () => {
      this.closed = true;
      this.#notify();
    });
    this.#consume(Buffer.alloc(0));
  }

  send(payload, opcode = 0x1) {
    this.socket.write(maskedFrame(payload, opcode));
  }

  async waitForJson(predicate, timeout = 1_000) {
    const found = this.#takeJson(predicate);
    if (found) return found;
    return this.#wait(() => this.#takeJson(predicate), timeout, 'JSON frame');
  }

  async waitForClose(timeout = 1_000) {
    if (this.closed) return this.closeCode;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== complete);
        reject(new Error('timed out waiting for socket close'));
      }, timeout);
      const complete = () => {
        if (!this.closed) return;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((waiter) => waiter !== complete);
        resolve(this.closeCode);
      };
      this.waiters.push(complete);
      complete();
    });
  }

  close() {
    if (!this.closed) this.socket.end(maskedFrame(Buffer.alloc(0), 0x8));
  }

  #consume(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const parsed = serverFrames(this.buffer);
    this.buffer = parsed.rest;
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x9 && this.autoPong) this.send(frame.payload, 0xA);
      if (frame.opcode === 0x8 && frame.payload.length >= 2) this.closeCode = frame.payload.readUInt16BE(0);
      this.frames.push(frame);
    }
    this.#notify();
  }

  #takeJson(predicate) {
    for (let index = 0; index < this.frames.length; index++) {
      const frame = this.frames[index];
      if (frame.opcode !== 0x1) continue;
      let value;
      try { value = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
      if (predicate(value)) {
        this.frames.splice(index, 1);
        return value;
      }
    }
    return null;
  }

  #wait(check, timeout, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== attempt);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeout);
      const attempt = () => {
        const result = check();
        if (result !== null && result !== undefined) {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((waiter) => waiter !== attempt);
          resolve(result);
        }
      };
      this.waiters.push(attempt);
      attempt();
    });
  }

  #notify() {
    for (const waiter of [...this.waiters]) waiter();
  }
}

function rawUpgrade({
  port,
  path: requestPath,
  cookie,
  origin,
  autoPong = true,
  allowHalfOpen = false,
  keepRejectedOpen = false,
}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: 'localhost', port, rejectUnauthorized: false, allowHalfOpen });
    let data = Buffer.alloc(0);
    const fail = (error) => { socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const headers = [
        `GET ${requestPath} HTTP/1.1`,
        `Host: localhost:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}`,
        `Origin: ${origin}`,
      ];
      if (cookie) headers.push(`Cookie: ${cookie}`);
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('error', fail);
      socket.off('data', onData);
      const head = data.subarray(0, end).toString('utf8');
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]);
      const body = data.subarray(end + 4);
      if (status === 101) resolve({ status, ws: new RawWebSocket(socket, body, autoPong) });
      else {
        if (keepRejectedOpen) {
          // Keep a harmless listener so a forced server-side destroy is not
          // treated as an unhandled client error by the test process.
          socket.on('error', () => {});
          resolve({ status, body: body.toString('utf8'), socket });
        } else {
          socket.end();
          resolve({ status, body: body.toString('utf8') });
        }
      }
    };
    socket.on('data', onData);
  });
}

function waitForSocketClose(socket, timeout = 1_500) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('close', complete);
      reject(new Error('timed out waiting for transport close'));
    }, timeout);
    const complete = () => {
      clearTimeout(timer);
      socket.off('close', complete);
      resolve();
    };
    socket.on('close', complete);
  });
}

function httpsRequest({ port, path: requestPath, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: 'localhost',
      port,
      path: requestPath,
      method,
      rejectUnauthorized: false,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function cookieValue(response) {
  const raw = response.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first?.split(';')[0];
}

test('room store isolates credentials, expires one-time links, and retains no samples', () => {
  let now = 1_000;
  const store = new RoomStore({ now: () => now, inviteTtlMs: 50, bootstrapTtlMs: 50, sessionTtlMs: 300, roomIdleTtlMs: 75 });
  const roomA = store.createRoom();
  const roomB = store.createRoom();
  assert.notEqual(roomA.roomId, roomB.roomId);
  assert.match(roomA.roomId, /^GO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(roomA.room.sample, undefined);
  assert.ok(store.claimHost(roomA.bootstrapToken));
});

test('room store lifecycle enforces role-bound, single-use credentials', () => {
  let now = 1_000;
  const store = new RoomStore({ now: () => now, inviteTtlMs: 50, bootstrapTtlMs: 50, sessionTtlMs: 300, roomIdleTtlMs: 75 });
  const created = store.createRoom();
  const host = store.claimHost(created.bootstrapToken);
  assert.ok(host);
  assert.equal(store.claimHost(created.bootstrapToken), null);
  assert.equal(store.issueInvite('wrong-host-token', 1), null);

  const invite = store.issueInvite(host.sessionToken, 1);
  assert.ok(invite);
  assert.match(invite.inviteToken, /^[A-Za-z0-9_-]{32}$/);
  const phone = store.claimPhone(invite.inviteToken);
  assert.ok(phone);
  assert.equal(phone.player, 1);
  assert.equal(store.claimPhone(invite.inviteToken), null);
  assert.equal(store.phoneContext(phone.sessionToken).room.id, created.roomId);
  assert.equal(store.phoneContext(phone.sessionToken).player, 1);

  const expiring = store.issueInvite(host.sessionToken, 2);
  now += 50;
  assert.equal(store.claimPhone(expiring.inviteToken), null, 'links expire at the advertised boundary');
  now += 100;
  store.createRoom();
  assert.equal(store.rooms.has(created.roomId), true, 'creating another room does not unqualified-sweep an existing room');
  assert.equal(store.sweep().length, 1, 'idle room is removed with all credential state');
  assert.equal(store.hostContext(host.sessionToken), null);
  assert.equal(store.phoneContext(phone.sessionToken), null);
});

test('websocket parser accepts only masked bounded final text frames', () => {
  const valid = decodeClientFrame(maskedFrame('hello'));
  assert.equal(valid.payload.toString('utf8'), 'hello');
  assert.equal(valid.opcode, 1);

  const unmasked = decodeClientFrame(Buffer.from([0x81, 0x01, 0x78]));
  assert.equal(unmasked.code, 1002);
  const fragmented = decodeClientFrame(Buffer.from([0x01, 0x80, 1, 2, 3, 4]));
  assert.equal(fragmented.code, 1002);

  const oversized = Buffer.alloc(10);
  oversized[0] = 0x81;
  oversized[1] = 0xff;
  oversized.writeBigUInt64BE(BigInt(MAX_INBOUND_MESSAGE_BYTES + 1), 2);
  const rejection = decodeClientFrame(oversized);
  assert.equal(rejection.code, 1009, 'a declared oversized partial frame is rejected before buffering it');

  const goodUpgrade = validateWebSocketUpgrade({
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      connection: 'keep-alive, Upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.alloc(16, 9).toString('base64'),
    },
  });
  assert.equal(goodUpgrade.ok, true);
  const malformedButDecodableKey = `${Buffer.alloc(16).toString('base64').slice(0, -2)}!!`;
  assert.equal(Buffer.from(malformedButDecodableKey, 'base64').length, 16, 'Node would otherwise decode this malformed key');
  assert.equal(validateWebSocketUpgrade({
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': malformedButDecodableKey,
    },
  }).ok, false, 'malformed Base64 keys are rejected');
  assert.equal(validateWebSocketUpgrade({ method: 'GET', headers: {} }).ok, false);
});

test('secure server isolates rooms and rejects unauthorised websocket access', async (t) => {
  const port = await freePort();
  const certificateDir = await mkdtemp(path.join(tmpdir(), 'secure-arcade-test-'));
  const app = createSecureArcadeServer({
    port,
    certDirectory: certificateDir,
    heartbeatIntervalMs: 40,
    heartbeatTimeoutMs: 120,
  });
  await app.start();
  t.after(async () => {
    await app.close();
    await rm(certificateDir, { recursive: true, force: true });
  });

  const origin = `https://localhost:${port}`;
  const createA = await httpsRequest({ port, method: 'POST', path: '/api/rooms', headers: { Origin: origin } });
  assert.equal(createA.status, 201);
  const hostUrlA = new URL(JSON.parse(createA.body).hostUrl);
  const hostClaimA = await httpsRequest({ port, path: `${hostUrlA.pathname}${hostUrlA.search}` });
  assert.equal(hostClaimA.status, 303);
  const hostCookieA = cookieValue(hostClaimA);
  assert.match(hostCookieA, /^__Host-go_arcade_host_GO-[A-Z0-9-]+=/);
  const hostPageA = new URL(hostClaimA.headers.location, origin);
  const roomA = hostPageA.searchParams.get('room');
  assert.match(roomA, /^GO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal((await httpsRequest({ port, path: `${hostPageA.pathname}${hostPageA.search}`, headers: { Cookie: hostCookieA } })).status, 200);

  const sessionA = await httpsRequest({ port, path: `/api/session?room=${encodeURIComponent(roomA)}`, headers: { Cookie: hostCookieA } });
  assert.equal(sessionA.status, 200);
  assert.equal(JSON.parse(sessionA.body).roomId, roomA);

  const inviteAResponse = await httpsRequest({
    port,
    method: 'POST',
    path: `/api/invites?room=${encodeURIComponent(roomA)}`,
    headers: { Origin: origin, Cookie: hostCookieA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: 1 }),
  });
  assert.equal(inviteAResponse.status, 201);
  const joinA = new URL(JSON.parse(inviteAResponse.body).joinUrl);
  const phoneClaimA = await httpsRequest({ port, path: `${joinA.pathname}${joinA.search}` });
  assert.equal(phoneClaimA.status, 303);
  const phoneCookieA = cookieValue(phoneClaimA);
  assert.match(phoneCookieA, /^__Host-go_arcade_phone_GO-[A-Z0-9-]+_1=/);
  const phonePageA = new URL(phoneClaimA.headers.location, origin);
  assert.equal(phonePageA.searchParams.get('room'), roomA);
  assert.equal(phonePageA.searchParams.get('player'), '1');
  assert.equal((await httpsRequest({ port, path: `${phonePageA.pathname}${phonePageA.search}`, headers: { Cookie: phoneCookieA } })).status, 200);
  const replayedJoin = await httpsRequest({ port, path: `${joinA.pathname}${joinA.search}` });
  assert.equal(replayedJoin.status, 303, 'phone link is one-time');
  assert.equal(replayedJoin.headers.location, '/link-expired.html');

  const createB = await httpsRequest({ port, method: 'POST', path: '/api/rooms', headers: { Origin: origin } });
  const hostUrlB = new URL(JSON.parse(createB.body).hostUrl);
  const hostClaimB = await httpsRequest({ port, path: `${hostUrlB.pathname}${hostUrlB.search}` });
  const hostCookieB = cookieValue(hostClaimB);
  const roomB = new URL(hostClaimB.headers.location, origin).searchParams.get('room');
  assert.notEqual(roomA, roomB);
  assert.notEqual(hostCookieA.split('=')[0], hostCookieB.split('=')[0], 'separate rooms receive separate browser cookie names');
  const hostCookieJar = `${hostCookieA}; ${hostCookieB}`;

  const rejectedOrigin = await rawUpgrade({ port, path: `/ws/monitor?room=${encodeURIComponent(roomA)}`, cookie: hostCookieJar, origin: `https://localhost:${port + 1}` });
  assert.equal(rejectedOrigin.status, 403);
  const rejectedPath = await rawUpgrade({ port, path: `/ws/monitor-extra?room=${encodeURIComponent(roomA)}`, cookie: hostCookieJar, origin });
  assert.equal(rejectedPath.status, 404);
  const rejectedAbsoluteTarget = await rawUpgrade({
    port,
    path: `https://unexpected.example/ws/monitor?room=${encodeURIComponent(roomA)}`,
    cookie: hostCookieJar,
    origin,
  });
  assert.equal(rejectedAbsoluteTarget.status, 404, 'absolute-form request targets are not valid bridge routes');
  const rejectedDotPath = await rawUpgrade({
    port,
    path: `/ws/%2e%2e/ws/monitor?room=${encodeURIComponent(roomA)}`,
    cookie: hostCookieJar,
    origin,
  });
  assert.equal(rejectedDotPath.status, 404, 'normalized dot-segment paths are not valid bridge routes');
  const rejectedRole = await rawUpgrade({ port, path: `/ws/monitor?room=${encodeURIComponent(roomA)}`, cookie: phoneCookieA, origin });
  assert.equal(rejectedRole.status, 401);

  const monitorAUpgrade = await rawUpgrade({ port, path: `/ws/monitor?room=${encodeURIComponent(roomA)}`, cookie: hostCookieJar, origin });
  const monitorBUpgrade = await rawUpgrade({ port, path: `/ws/monitor?room=${encodeURIComponent(roomB)}`, cookie: hostCookieJar, origin });
  const phoneAUpgrade = await rawUpgrade({ port, path: `/ws/phone?room=${encodeURIComponent(roomA)}&player=1`, cookie: phoneCookieA, origin });
  assert.equal(monitorAUpgrade.status, 101);
  assert.equal(monitorBUpgrade.status, 101);
  assert.equal(phoneAUpgrade.status, 101);
  const monitorA = monitorAUpgrade.ws;
  const monitorB = monitorBUpgrade.ws;
  const phoneA = phoneAUpgrade.ws;
  await monitorA.waitForJson((message) => message.type === 'status' && message.roomId === roomA);
  await monitorB.waitForJson((message) => message.type === 'status' && message.roomId === roomB);

  phoneA.send(JSON.stringify({ type: 'stream', active: true }));
  phoneA.send(JSON.stringify({ type: 'sample', x: 11.25, y: -2.5, z: 4.75 }));
  const sampleA = await monitorA.waitForJson((message) => message.type === 'sample');
  assert.deepEqual(sampleA, { type: 'sample', x: 11.25, y: -2.5, z: 4.75, player: 1 });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(monitorB.frames.some((frame) => frame.opcode === 1 && frame.payload.toString('utf8').includes('11.25')), false, 'room B receives no room A sample');

  const laterMonitorUpgrade = await rawUpgrade({ port, path: `/ws/monitor?room=${encodeURIComponent(roomA)}`, cookie: hostCookieJar, origin });
  const laterMonitor = laterMonitorUpgrade.ws;
  await laterMonitor.waitForJson((message) => message.type === 'status');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(laterMonitor.frames.some((frame) => frame.opcode === 1 && frame.payload.toString('utf8').includes('11.25')), false, 'new monitors receive no replayed sample');

  phoneA.send(Buffer.alloc(MAX_INBOUND_MESSAGE_BYTES + 1, 0x61));
  assert.equal(await phoneA.waitForClose(), 1009, 'oversized messages close immediately');

  const inviteP2 = await httpsRequest({
    port,
    method: 'POST',
    path: `/api/invites?room=${encodeURIComponent(roomA)}`,
    headers: { Origin: origin, Cookie: hostCookieA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: 2 }),
  });
  const joinP2 = new URL(JSON.parse(inviteP2.body).joinUrl);
  const phoneClaimP2 = await httpsRequest({ port, path: `${joinP2.pathname}${joinP2.search}` });
  const phoneCookieP2 = cookieValue(phoneClaimP2);
  const phoneP2Path = `/ws/phone?room=${encodeURIComponent(roomA)}&player=2`;
  const phoneP2Upgrade = await rawUpgrade({ port, path: phoneP2Path, cookie: phoneCookieP2, origin });
  phoneP2Upgrade.ws.send(JSON.stringify({ type: 'stream', active: true }));
  for (let index = 0; index < 90; index++) {
    phoneP2Upgrade.ws.send(JSON.stringify({ type: 'sample', x: index, y: 0, z: 0 }));
  }
  assert.equal(await phoneP2Upgrade.ws.waitForClose(800), 1008, 'per-phone message rate is enforced');
  const reconnectP2 = await rawUpgrade({ port, path: phoneP2Path, cookie: phoneCookieP2, origin });
  reconnectP2.ws.send(Buffer.alloc(0), 0x9);
  assert.equal(await reconnectP2.ws.waitForClose(800), 1008, 'the rate limit survives a reconnect for the same phone session');

  const heartbeatInvite = await httpsRequest({
    port,
    method: 'POST',
    path: `/api/invites?room=${encodeURIComponent(roomA)}`,
    headers: { Origin: origin, Cookie: hostCookieA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: 2 }),
  });
  const heartbeatJoin = new URL(JSON.parse(heartbeatInvite.body).joinUrl);
  const heartbeatClaim = await httpsRequest({ port, path: `${heartbeatJoin.pathname}${heartbeatJoin.search}` });
  const heartbeatCookie = cookieValue(heartbeatClaim);
  const controlFlood = await rawUpgrade({ port, path: phoneP2Path, cookie: heartbeatCookie, origin });
  for (let index = 0; index < 91; index++) controlFlood.ws.send(Buffer.alloc(0), 0x9);
  assert.equal(await controlFlood.ws.waitForClose(800), 1008, 'control-frame floods are rate limited too');

  const finalHeartbeatInvite = await httpsRequest({
    port,
    method: 'POST',
    path: `/api/invites?room=${encodeURIComponent(roomA)}`,
    headers: { Origin: origin, Cookie: hostCookieA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: 2 }),
  });
  const finalHeartbeatJoin = new URL(JSON.parse(finalHeartbeatInvite.body).joinUrl);
  const finalHeartbeatClaim = await httpsRequest({ port, path: `${finalHeartbeatJoin.pathname}${finalHeartbeatJoin.search}` });
  const unresponsivePhone = await rawUpgrade({ port, path: phoneP2Path, cookie: cookieValue(finalHeartbeatClaim), origin, autoPong: false });
  assert.equal(await unresponsivePhone.ws.waitForClose(800), null, 'a peer that misses Ping/Pong is terminated');

  monitorA.close();
  monitorB.close();
  laterMonitor.close();
});

test('close paths bound half-open rejected and policy-closed transports', async (t) => {
  const port = await freePort();
  const certificateDir = await mkdtemp(path.join(tmpdir(), 'secure-arcade-close-test-'));
  const app = createSecureArcadeServer({
    port,
    certDirectory: certificateDir,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 2_000,
    closeHandshakeTimeoutMs: 75,
  });
  await app.start();
  t.after(async () => {
    await app.close();
    await rm(certificateDir, { recursive: true, force: true });
  });

  const origin = `https://localhost:${port}`;
  const created = await httpsRequest({ port, method: 'POST', path: '/api/rooms', headers: { Origin: origin } });
  const hostUrl = new URL(JSON.parse(created.body).hostUrl);
  const hostClaim = await httpsRequest({ port, path: `${hostUrl.pathname}${hostUrl.search}` });
  const hostCookie = cookieValue(hostClaim);
  const roomId = new URL(hostClaim.headers.location, origin).searchParams.get('room');
  const monitorPath = `/ws/monitor?room=${encodeURIComponent(roomId)}`;

  const rejected = await rawUpgrade({
    port,
    path: monitorPath,
    origin,
    allowHalfOpen: true,
    keepRejectedOpen: true,
  });
  assert.equal(rejected.status, 401);
  const rejectedWrites = setInterval(() => {
    try { rejected.socket.write('still here'); } catch {}
  }, 10);
  t.after(() => {
    clearInterval(rejectedWrites);
    rejected.socket.destroy();
  });
  await waitForSocketClose(rejected.socket, 1_500);
  clearInterval(rejectedWrites);

  const inviteResponse = await httpsRequest({
    port,
    method: 'POST',
    path: `/api/invites?room=${encodeURIComponent(roomId)}`,
    headers: { Origin: origin, Cookie: hostCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: 1 }),
  });
  const joinUrl = new URL(JSON.parse(inviteResponse.body).joinUrl);
  const phoneClaim = await httpsRequest({ port, path: `${joinUrl.pathname}${joinUrl.search}` });
  const phoneCookie = cookieValue(phoneClaim);
  const phonePath = `/ws/phone?room=${encodeURIComponent(roomId)}&player=1`;
  const policyClosed = await rawUpgrade({
    port,
    path: phonePath,
    cookie: phoneCookie,
    origin,
    allowHalfOpen: true,
  });
  assert.equal(policyClosed.status, 101);
  const policyWrites = setInterval(() => {
    try { policyClosed.ws.send(Buffer.alloc(0), 0x9); } catch {}
  }, 10);
  t.after(() => {
    clearInterval(policyWrites);
    policyClosed.ws.socket.destroy();
  });
  policyClosed.ws.send(JSON.stringify({ type: 'sample', x: 1, y: 2, z: 3 }));
  assert.equal(await policyClosed.ws.waitForClose(800), 1008, 'a policy close destroys a peer that keeps its side open');
  clearInterval(policyWrites);
});
