// Explicit sensor-data storage. Item 5: by default this app NEVER retains or
// logs sensor payloads. Storage only happens if ALL of these are set, and only
// in the way described:
//
//   SENSOR_LOG=<absolute path>   file a JSON Lines log is appended to
//   SENSOR_LOG_RETENTION_MS=<ms> auto-purge window; older lines are dropped.
//       Default 24h. Set to 0 to disable purging (use with caution).
//
// When no SENSOR_LOG is set, maybeOpenSensorLog returns null and samples are
// never written anywhere: they exist only in memory for the ~1 relay hop.
//
// The log stores fused accelerometer fields only. It deliberately omits
// identifying info: no device fingerprint, no client IP, no player chip
// (player is connection state, not stable identity). HMAC of join token is not
// linkable to a person.
import { createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_LINE_BYTES = 4 * 1024;

export function maybeOpenSensorLog(env = process.env) {
  const target = env.SENSOR_LOG;
  if (!target) return null;

  const retentionMsRaw = Number(env.SENSOR_LOG_RETENTION_MS);
  const retentionMs = Number.isFinite(retentionMsRaw) && retentionMsRaw >= 0
    ? retentionMsRaw
    : DEFAULT_RETENTION_MS;

  let stream = null;
  let opened = false;

  async function ensureOpen() {
    if (opened) return;
    const abs = path.resolve(target);
    await mkdir(path.dirname(abs), { recursive: true });
    stream = createWriteStream(abs, { flags: 'a' });
    stream.on('error', (e) => console.error('[sensor-log]', e.message));
    opened = true;
  }

  async function purge() {
    if (!retentionMs) return;
    const abs = path.resolve(target);
    if (!existsSync(abs)) return;
    let stat;
    try { stat = statSync(abs); } catch { return; }
    if (Date.now() - stat.mtimeMs > retentionMs) {
      try { unlinkSync(abs); } catch {}
    }
  }

  return {
    async write(msg) {
      if (stream) {
        const line = JSON.stringify({
          t: msg.t,
          x: msg.x, y: msg.y, z: msg.z,
          ax: msg.ax ?? null, ay: msg.ay ?? null, az: msg.az ?? null,
          fx: msg.fx, fy: msg.fy, fz: msg.fz, fmag: msg.fmag,
          hwWeight: msg.hwWeight, settled: !!msg.settled,
        });
        if (line.length <= MAX_LINE_BYTES) stream.write(line + '\n');
        return;
      }
      await ensureOpen();
      if (stream) stream.write(JSON.stringify({
        t: msg.t, x: msg.x, y: msg.y, z: msg.z,
        ax: msg.ax ?? null, ay: msg.ay ?? null, az: msg.az ?? null,
        fx: msg.fx, fy: msg.fy, fz: msg.fz, fmag: msg.fmag,
        hwWeight: msg.hwWeight, settled: !!msg.settled,
      }) + '\n');
    },
    async pruneNow() { await purge(); },
    describe() {
      return `ENABLED -> ${path.resolve(target)} (retention ${retentionMs >= DEFAULT_RETENTION_MS ? '24h' : retentionMs + 'ms'})`;
    },
  };
}