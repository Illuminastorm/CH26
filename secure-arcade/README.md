# Secure Arcade Edition

This is an additive replacement runtime for the room/session flow. It leaves every existing server, page, package script, and game file unchanged.

Run it from the repository root:

```powershell
node secure-arcade/server.mjs
```

It listens on port `9443` by default and prints the LAN-reachable HTTPS address to use for both the laptop host console and phone links. Use that printed address rather than a phone's `localhost`. On first run it creates a self-signed certificate under `secure-arcade/certs/`; accept the certificate warning for that address on the laptop and phones before using the local HTTPS page. To use a different free port:

```powershell
$env:SECURE_ARCADE_PORT=9555
node secure-arcade/server.mjs
```

The new runtime is intentionally separate because the original command and pages are untouched by request. Do not use `npm run accel` for a secured room: that starts the legacy, unscoped bridge.

## Session flow

1. Open the secure lobby on the laptop and create a room.
2. The lobby displays a random room ID and can issue a Player 1 or Player 2 link.
3. Each player link has a cryptographically random, one-time token and expires after five minutes.
4. Opening the link exchanges the token for a room-and-player-specific `HttpOnly`, `Secure`, `SameSite=Strict` phone cookie, then redirects to a token-free phone screen.
5. The room ID and player slot in the redirected URL are identifiers, not credentials. The matching cookie is still required.
6. The host cookie is the only credential accepted by the room monitor. Phones cannot use monitor endpoints, and monitors cannot send sensor messages.

Sensor samples exist only long enough to fan out to monitors in the same active room. This edition has no sample replay, CSV logging, sensor console output, device metadata logging, or persistent sensor store.

## Network policy

The bridge accepts only exact HTTPS origins for `localhost`, `127.0.0.1`, `::1`, and the laptop's current LAN IPv4 addresses on its configured port. Its only WebSocket routes are canonical `/ws/phone?room=...&player=...` and `/ws/monitor?room=...`; both require their matching session cookie. Unexpected origins, request targets, paths, roles, and credentials are rejected before the upgrade completes.

The WebSocket server requires RFC 6455 version 13, a canonical handshake key, and masked client frames. It caps messages at 4 KiB, bounds receive/output buffers, validates finite bounded sensor coordinates, applies a sliding 90-frame-per-second limit to every phone frame (including Ping/Pong), and closes stale peers with Ping/Pong heartbeats. Both rejected upgrades and closing WebSockets have bounded transport shutdowns so half-open peers cannot remain attached.

## Verification

Run the standalone acceptance suite with:

```powershell
node --test secure-arcade/security.test.mjs
```

It covers credential lifecycle, isolation between two rooms, origin/path/role rejection, sample non-replay, frame and rate limits, heartbeat cleanup, and hostile half-open transport cleanup.
