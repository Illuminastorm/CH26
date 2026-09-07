// Reject repeated back-and-forth shaking without penalising the acceleration
// reversal that naturally follows one punch.  The phone's orientation is not
// fixed, so every local device axis is considered rather than assuming Y is
// "up".  A shake needs four strong lobes (three direction reversals) on the
// same axis at a steady cadence in a short, continuous window.
export function createShakeGuard({
  threshold = 4.5,       // m/s²: safely above normal sensor noise
  minReversals = 5,
  minDuration = 450,     // ms: prevents a punch followed by a pullback matching
  maxWindow = 900,       // ms: distinguishes sustained shaking from play
  maxReversalGap = 180,  // ms: a shake has a regular, uninterrupted cadence
  latchFor = 1000,       // ms: keep rejecting the tail of a detected shake
} = {}) {
  const axes = [null, null, null];
  let blockedUntil = -Infinity;

  return function check({ t, x, y, z }) {
    const values = [x, y, z];
    let detected = false;

    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isFinite(value) || Math.abs(value) < threshold) continue;

      const sign = Math.sign(value);
      let axis = axes[i];
      // Do not join separated movements into one shake.  In particular, a
      // player may pull their hand back after a punch, then punch again.
      if (!axis || t - axis.lastStrongAt > maxReversalGap) {
        axes[i] = { sign, reversals: [], startedAt: t, lastStrongAt: t };
        continue;
      }

      axis.lastStrongAt = t;
      if (axis.sign === sign) continue;
      axis.sign = sign;
      axis.reversals.push(t);
      axis.reversals = axis.reversals.filter((at) => t - at <= maxWindow);

      // The first lobe starts the sequence. Three reversals means strong
      // acceleration in alternating directions six times, at a continuous
      // cadence.  A punch and its pullback can create several lobes, whereas
      // this requires multiple complete shake cycles.
      if (axis.reversals.length >= minReversals && t - axis.startedAt >= minDuration && t >= blockedUntil) {
        detected = true;
        blockedUntil = Math.max(blockedUntil, t + latchFor);
      }

      // A long sequence is no longer a single motion; start it over so stale
      // reversals cannot combine with a later pullback.
      if (t - axis.startedAt > maxWindow) {
        axes[i] = { sign, reversals: [], startedAt: t, lastStrongAt: t };
      }
    }

    return { blocked: detected || t < blockedUntil, detected };
  };
}
