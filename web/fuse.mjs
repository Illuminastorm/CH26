// Shared by the Node bridge and the in-browser boxing game, so it lives under
// web/ where the static server can hand it to the phone as a module.
// Sensor fusion: turns two noisy accelerometer streams into one clean estimate
// of linear acceleration.
//
// The two inputs are NOT independent measurements of the same quantity --
// raw = linear + gravity -- so they must never be averaged directly. Instead:
//
//   1. Low-pass the raw signal to track gravity (it is near-DC; motion is not).
//   2. derived = raw - gravity  ->  a second estimate of linear acceleration,
//      independent of the hardware one because it comes from a different
//      sensor pipeline.
//   3. Average those two. Their noise is uncorrelated, so the average has
//      lower variance than either input.
//
// Weighting is inverse to each estimate's measured noise, so a device with a
// good hardware fusion chip leans on it, and a noisy one leans on the derived
// signal, without needing per-device tuning.

const G = 9.80665;

export function createFuser(opts = {}) {
  const gravityTau = opts.gravityTau ?? 0.5;  // s; gravity tracking (slow)
  const smoothTau = opts.smoothTau ?? 0.02;   // s; output smoothing (~8Hz)
  const noiseTau = opts.noiseTau ?? 1.0;      // s; noise-estimate adaptation
  const biasTau = opts.biasTau ?? 0.15;       // s; systematic-disagreement estimate
  const despike = opts.despike ?? true;       // median-of-3 spike rejection
  const maxDt = 0.25;                         // clamp gaps from a stalled tab

  let gravity = null;   // [x,y,z]
  let smooth = null;    // [x,y,z]
  let lastT = null;
  let firstT = null;
  let count = 0;

  // Rolling window for median-of-3 spike rejection, per axis.
  const window = [[], [], []];
  // Per-estimator noise proxy: mean absolute sample-to-sample jump. Real
  // motion is smooth at these rates, so jitter is mostly noise.
  const jitter = { hw: null, derived: null };
  const prev = { hw: null, derived: null };
  // Sustained disagreement between the two estimates, dominated by
  // gravity-tracking lag in the derived signal -- a systematic error that
  // jitter cannot see, and the reason naive weighting can make output worse.
  let diffLp = null;   // low-passed (derived - hw)

  // Running scale estimate per axis, used as the outlier threshold.
  const scale = [null, null, null];
  const SPIKE_K = 4;

  function gate(i, v) {
    const med = median3(window[i], v);
    const predicted = smooth ? smooth[i] : v;
    const dev = Math.abs(v - predicted);

    if (scale[i] === null) { scale[i] = dev; return v; }

    const isSpike = dev > SPIKE_K * scale[i] + 0.05;
    // Update the scale only from samples we accepted, so a burst of spikes
    // cannot inflate the threshold and disable the gate.
    if (!isSpike) scale[i] += 0.05 * (dev - scale[i]);
    return isSpike ? med : v;
  }

  return function push(sample) {
    const t = sample.t / 1000;
    const dt = lastT === null ? 1 / 60 : Math.min(Math.max(t - lastT, 1e-3), maxDt);
    if (firstT === null) firstT = t;
    lastT = t;
    count++;

    const raw = [sample.x ?? 0, sample.y ?? 0, sample.z ?? 0];

    // --- 1. gravity ---------------------------------------------------------
    // Seeded from the first sample; starting at zero would inject a fake 1g
    // transient that takes a second to decay.
    if (!gravity) {
      gravity = [...raw];
    } else {
      const a = dt / (gravityTau + dt);
      for (let i = 0; i < 3; i++) gravity[i] += a * (raw[i] - gravity[i]);
    }

    // --- 2. two estimates of linear acceleration ----------------------------
    const derived = [raw[0] - gravity[0], raw[1] - gravity[1], raw[2] - gravity[2]];

    const hwValid = ['ax', 'ay', 'az'].every((k) => Number.isFinite(sample[k]));
    const hw = hwValid ? [sample.ax, sample.ay, sample.az] : null;

    // --- 3. inverse-noise weighted blend ------------------------------------
    trackJitter('derived', derived, dt);
    if (hw) trackJitter('hw', hw, dt);

    let fused;
    let weight = null;
    if (hw) {
      // Low-pass the difference VECTOR, then take its magnitude. Filtering
      // first strips the two sensors' mutual white noise, leaving the
      // systematic gravity-lag error; taking the magnitude first instead would
      // fold that noise into the estimate and over-penalise the derived signal.
      // The time constant is short enough that lag error at motion frequencies
      // still survives.
      const ab = dt / (biasTau + dt);
      const diff = [0, 1, 2].map((i) => derived[i] - hw[i]);
      if (!diffLp) diffLp = diff;
      else for (let i = 0; i < 3; i++) diffLp[i] += ab * (diff[i] - diffLp[i]);

      if (jitter.hw !== null && jitter.derived !== null) {
        // Inverse-variance weighting. The derived estimate's variance carries
        // both its noise and its systematic gravity-tracking error, so when
        // gravity tracking degrades the blend falls back toward the hardware
        // sensor instead of dragging the output off.
        const vh = jitter.hw ** 2 + 1e-9;
        const vd = jitter.derived ** 2 + Math.hypot(...diffLp) ** 2 + 1e-9;
        weight = (1 / vh) / (1 / vh + 1 / vd);
      } else {
        weight = 0.5;
      }
      fused = [0, 1, 2].map((i) => weight * hw[i] + (1 - weight) * derived[i]);
    } else {
      weight = 0;
      fused = derived;
    }

    // --- 4. spike rejection, then smoothing ---------------------------------
    // Spike rejection is GATED. Applying a median unconditionally costs real
    // accuracy on clean data (it clips genuine peaks), while doing nothing lets
    // a single bad sample dominate. So the median only replaces a sample that
    // is a statistical outlier against the signal's own recent variability.
    const despiked = despike ? fused.map((v, i) => gate(i, v)) : fused;

    if (!smooth) {
      smooth = [...despiked];
    } else {
      const a = dt / (smoothTau + dt);
      for (let i = 0; i < 3; i++) smooth[i] += a * (despiked[i] - smooth[i]);
    }

    const gMag = Math.hypot(...gravity);
    return {
      x: smooth[0], y: smooth[1], z: smooth[2],
      mag: Math.hypot(...smooth),
      gravity: [...gravity],
      // How much of the blend came from the hardware sensor (0..1).
      hwWeight: weight,
      // |gravity| should sit at 9.81. Drift means the low-pass is still
      // converging or sustained motion is leaking into the gravity estimate.
      gravityError: gMag - G,
      // Disagreement between the two independent estimates. Small = trustworthy.
      spread: hw ? Math.hypot(hw[0] - derived[0], hw[1] - derived[1], hw[2] - derived[2]) : null,
      // The filters need a few time constants before output is meaningful.
      settled: t - firstT > gravityTau * 3,
      sources: hw ? 2 : 1,
    };
  };

  function trackJitter(key, vec, dt) {
    const p = prev[key];
    prev[key] = [...vec];
    if (!p) return;
    const d = Math.hypot(vec[0] - p[0], vec[1] - p[1], vec[2] - p[2]);
    const a = dt / (noiseTau + dt);
    jitter[key] = jitter[key] === null ? d : jitter[key] + a * (d - jitter[key]);
  }
}

// Median of the last three samples: removes single-sample spikes without the
// smearing a mean would cause.
function median3(buf, v) {
  buf.push(v);
  if (buf.length > 3) buf.shift();
  if (buf.length < 3) return v;
  const [a, b, c] = buf;
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}
