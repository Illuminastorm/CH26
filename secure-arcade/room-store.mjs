import { createHash, randomBytes } from 'node:crypto';

export const INVITE_TTL_MS = 5 * 60 * 1000;
export const BOOTSTRAP_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const ROOM_IDLE_TTL_MS = 20 * 60 * 1000;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function tokenHash(token) {
  if (typeof token !== 'string') return null;
  return createHash('sha256').update(token).digest('base64url');
}

function opaqueToken() {
  // 192 bits is deliberately much stronger than a human room ID. Tokens are
  // only ever stored as SHA-256 hashes in the in-memory registry.
  return randomBytes(24).toString('base64url');
}

function roomId() {
  const bytes = randomBytes(12);
  let value = '';
  for (let i = 0; i < 12; i++) value += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return `GO-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

/**
 * In-memory registry for one secure arcade process.
 *
 * It deliberately has no sample field, history, logger, or file backing: a
 * room only owns credentials and lifecycle metadata. Socket sets belong to the
 * server so this module stays easy to test with an injected clock.
 */
export class RoomStore {
  constructor({
    now = () => Date.now(),
    inviteTtlMs = INVITE_TTL_MS,
    bootstrapTtlMs = BOOTSTRAP_TTL_MS,
    sessionTtlMs = SESSION_TTL_MS,
    roomIdleTtlMs = ROOM_IDLE_TTL_MS,
  } = {}) {
    this.now = now;
    this.inviteTtlMs = inviteTtlMs;
    this.bootstrapTtlMs = bootstrapTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.roomIdleTtlMs = roomIdleTtlMs;
    this.rooms = new Map();
    this.hostBootstraps = new Map();
    this.phoneInvites = new Map();
  }

  createRoom() {
    // The server owns the active-socket predicate used by sweep(). Do not run
    // an unqualified sweep here: creating one room must never expire another
    // room that currently has a live monitor or phone connection.
    let id;
    do { id = roomId(); } while (this.rooms.has(id));

    const now = this.now();
    const room = {
      id,
      createdAt: now,
      lastActivityAt: now,
      closed: false,
      hostSessions: new Map(),
      phoneSessions: new Map(),
      inviteByPlayer: new Map(),
    };
    this.rooms.set(id, room);

    const bootstrapToken = opaqueToken();
    this.hostBootstraps.set(tokenHash(bootstrapToken), {
      roomId: id,
      expiresAt: now + this.bootstrapTtlMs,
    });

    return {
      room,
      roomId: id,
      bootstrapToken,
      expiresAt: now + this.bootstrapTtlMs,
    };
  }

  claimHost(bootstrapToken) {
    const hash = tokenHash(bootstrapToken);
    if (!hash) return null;
    const grant = this.hostBootstraps.get(hash);
    const now = this.now();
    if (!grant || grant.expiresAt <= now) {
      this.hostBootstraps.delete(hash);
      return null;
    }

    const room = this.rooms.get(grant.roomId);
    this.hostBootstraps.delete(hash); // Bootstrap links are one-time.
    if (!room || room.closed) return null;

    const sessionToken = opaqueToken();
    const sessionHash = tokenHash(sessionToken);
    const expiresAt = now + this.sessionTtlMs;
    room.hostSessions.set(sessionHash, { expiresAt });
    this.touch(room);
    return { room, sessionToken, sessionHash, expiresAt };
  }

  hostContext(sessionToken) {
    const context = this.#sessionContext(sessionToken, 'host');
    return context ? { room: context.room, sessionHash: context.sessionHash, expiresAt: context.session.expiresAt } : null;
  }

  phoneContext(sessionToken) {
    const context = this.#sessionContext(sessionToken, 'phone');
    if (!context) return null;
    return {
      room: context.room,
      sessionHash: context.sessionHash,
      player: context.session.player,
      expiresAt: context.session.expiresAt,
    };
  }

  issueInvite(hostSessionToken, player) {
    if (player !== 1 && player !== 2) return null;
    const host = this.hostContext(hostSessionToken);
    if (!host) return null;

    const { room } = host;
    const oldHash = room.inviteByPlayer.get(player);
    if (oldHash) this.phoneInvites.delete(oldHash);

    const inviteToken = opaqueToken();
    const inviteHash = tokenHash(inviteToken);
    const expiresAt = this.now() + this.inviteTtlMs;
    this.phoneInvites.set(inviteHash, { roomId: room.id, player, expiresAt });
    room.inviteByPlayer.set(player, inviteHash);
    this.touch(room);
    return { room, inviteToken, expiresAt, player };
  }

  claimPhone(inviteToken) {
    const inviteHash = tokenHash(inviteToken);
    if (!inviteHash) return null;
    const invite = this.phoneInvites.get(inviteHash);
    const now = this.now();
    if (!invite || invite.expiresAt <= now) {
      this.phoneInvites.delete(inviteHash);
      return null;
    }

    const room = this.rooms.get(invite.roomId);
    this.phoneInvites.delete(inviteHash); // A join URL cannot be replayed.
    if (!room || room.closed || room.inviteByPlayer.get(invite.player) !== inviteHash) return null;
    room.inviteByPlayer.delete(invite.player);

    // A newly accepted invite replaces any older phone credential for the
    // player. The server closes sockets for these hashes immediately.
    const invalidatedSessionHashes = [];
    for (const [hash, session] of room.phoneSessions) {
      if (session.player === invite.player) {
        room.phoneSessions.delete(hash);
        invalidatedSessionHashes.push(hash);
      }
    }

    const sessionToken = opaqueToken();
    const sessionHash = tokenHash(sessionToken);
    const expiresAt = now + this.sessionTtlMs;
    room.phoneSessions.set(sessionHash, { player: invite.player, expiresAt });
    this.touch(room);
    return {
      room,
      player: invite.player,
      sessionToken,
      sessionHash,
      expiresAt,
      invalidatedSessionHashes,
    };
  }

  closeRoom(hostSessionToken) {
    const host = this.hostContext(hostSessionToken);
    if (!host) return null;
    return this.#removeRoom(host.room);
  }

  touch(room) {
    if (room && !room.closed) room.lastActivityAt = this.now();
  }

  sweep({ hasActiveConnections = () => false } = {}) {
    const now = this.now();
    for (const [hash, grant] of this.hostBootstraps) {
      if (grant.expiresAt <= now || !this.rooms.has(grant.roomId)) this.hostBootstraps.delete(hash);
    }
    for (const [hash, invite] of this.phoneInvites) {
      if (invite.expiresAt <= now || !this.rooms.has(invite.roomId)) {
        this.phoneInvites.delete(hash);
        const room = this.rooms.get(invite.roomId);
        if (room && room.inviteByPlayer.get(invite.player) === hash) room.inviteByPlayer.delete(invite.player);
      }
    }

    const removed = [];
    for (const room of this.rooms.values()) {
      for (const [hash, session] of room.hostSessions) {
        if (session.expiresAt <= now) room.hostSessions.delete(hash);
      }
      for (const [hash, session] of room.phoneSessions) {
        if (session.expiresAt <= now) room.phoneSessions.delete(hash);
      }
      if (room.closed || (!hasActiveConnections(room) && now - room.lastActivityAt >= this.roomIdleTtlMs)) {
        removed.push(this.#removeRoom(room));
      }
    }
    return removed;
  }

  #sessionContext(sessionToken, kind) {
    if (typeof sessionToken !== 'string' || sessionToken.length < 20) return null;
    const sessionHash = tokenHash(sessionToken);
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (room.closed) continue;
      const sessions = kind === 'host' ? room.hostSessions : room.phoneSessions;
      const session = sessions.get(sessionHash);
      if (!session) continue;
      if (session.expiresAt <= now) {
        sessions.delete(sessionHash);
        return null;
      }
      this.touch(room);
      return { room, session, sessionHash };
    }
    return null;
  }

  #removeRoom(room) {
    if (!room || room.closed) return room;
    room.closed = true;
    this.rooms.delete(room.id);
    for (const [hash, grant] of this.hostBootstraps) {
      if (grant.roomId === room.id) this.hostBootstraps.delete(hash);
    }
    for (const [hash, invite] of this.phoneInvites) {
      if (invite.roomId === room.id) this.phoneInvites.delete(hash);
    }
    room.hostSessions.clear();
    room.phoneSessions.clear();
    room.inviteByPlayer.clear();
    return room;
  }
}
