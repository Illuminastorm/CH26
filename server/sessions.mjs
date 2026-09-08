// Game session registry. Each game (monitor) and each phone (stream) belongs
// to exactly one session; a session only ever relays the streams that joined
// it. This is what lets one game receive only its own phones' data.
//
// No sensor payloads are stored here: sessions track connection identity and
// join authorization only. Sensor data streams straight from the phone to the
// same session's monitors and is never retained.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const CODE_LEN = 4;
const TOKEN_BYTES = 24;        // 192-bit join token
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // an unused session expires
const SWEEP_MS = 60 * 1000;

export function createSessionStore() {
  const sessions = new Map(); // id -> session
  let sweepTimer = null;

  function newSession() {
    const id = randomBytes(9).toString('base64url'); // 72-bit id
    const code = genCode();
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = Date.now();
    const session = {
      id,
      code,
      token,             // plaintext, needed to hand fresh tokens to joiners
      tokenHash: sha256(token),
      createdAt: now,
      lastActiveAt: now,
      monitors: new Set(), // ws connections
      phones: new Set(),   // ws connections
      streamCount: 0,
    };
    sessions.set(id, session);
    return { id, code, token, session };
  }

  function get(id) {
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    s.lastActiveAt = Date.now();
    return s;
  }

  function touch(session) {
    session.lastActiveAt = Date.now();
  }

  function authorize(id, token) {
    const s = get(id);
    if (!s) return null;
    const candidate = sha256(String(token || ''));
    if (candidate.length !== s.tokenHash.length) return null;
    if (!timingSafeEqual(Buffer.from(s.tokenHash), Buffer.from(candidate))) return null;
    return s;
  }

  // Resolve a short human-friendly code to its live session and mint a fresh
  // per-phone join token. The token is just the session's token kept in the
  // store; returning it lets a phone connect without the host discarding it.
  function joinByCode(code) {
    if (!code) return null;
    const norm = String(code).trim().toUpperCase();
    for (const s of sessions.values()) {
      if (s.code === norm && !isExpired(s)) {
        s.lastActiveAt = Date.now();
        return { id: s.id, token: s.token };
      }
    }
    return null;
  }

  function addMonitor(session, ws) { session.monitors.add(ws); }
  function addPhone(session, ws) { session.phones.add(ws); }
  function removeMonitor(session, ws) { session.monitors.delete(ws); }
  function removePhone(session, ws) { session.phones.delete(ws); }

  function monitors(session) { return session.monitors; }
  function phoneCount(session) { return session.phones.size; }

  function broadcast(session, text) {
    for (const m of session.monitors) m.send(text);
  }

  function isExpired(s) {
    return Date.now() - s.lastActiveAt > SESSION_TTL_MS;
  }

  function prune() {
    for (const [id, s] of sessions) {
      if (isExpired(s)) {
        for (const ws of s.monitors) { try { ws.close(); } catch {} }
        for (const ws of s.phones) { try { ws.close(); } catch {} }
        sessions.delete(id);
      }
    }
  }

  function startSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(prune, SWEEP_MS);
    sweepTimer.unref?.();
  }

  function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    for (const s of sessions.values()) {
      for (const ws of s.monitors) { try { ws.close(); } catch {} }
      for (const ws of s.phones) { try { ws.close(); } catch {} }
    }
    sessions.clear();
  }

  return {
    newSession, get, authorize, touch, joinByCode,
    addMonitor, addPhone, removeMonitor, removePhone,
    monitors, phoneCount, broadcast,
    startSweep, stop,
  };
}

function genCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

function sha256(s) {
  return createHash('sha256').update(String(s)).digest('base64url');
}