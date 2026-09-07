// Validates the fusion claims against synthetic data with known ground truth.
//   node server/fuse.test.mjs
import { createFuser } from '../web/fuse.mjs';

const HZ = 60, N = HZ * 40, G = 9.80665;
const S_RAW = 0.35, S_HW = 0.30;

function simulate({ despike = true, spikeRate = 0, seedInit = 4242 } = {}) {
  let seed = seedInit;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const spike = () => (rnd() < spikeRate ? (rnd() < 0.5 ? -1 : 1) * (8 + rnd() * 15) : 0);

  const fuse = createFuser({ despike });
  const smoothTau = 0.02;
  const errFused = [], errHw = [];
  let hwSmooth = null;

  for (let i = 0; i < N; i++) {
    const t = i / HZ;
    const m = [2 * Math.sin(2 * Math.PI * t), 1.2 * Math.sin(2 * Math.PI * 0.6 * t), 0];
    const tilt = 0.3 * Math.sin(2 * Math.PI * 0.05 * t);
    const g = [G * Math.sin(tilt), 0, G * Math.cos(tilt)];

    const s = {
      t: t * 1000,
      x: g[0] + m[0] + gauss() * S_RAW + spike(),
      y: g[1] + m[1] + gauss() * S_RAW + spike(),
      z: g[2] + m[2] + gauss() * S_RAW + spike(),
      ax: m[0] + gauss() * S_HW + spike(),
      ay: m[1] + gauss() * S_HW + spike(),
      az: m[2] + gauss() * S_HW + spike(),
    };
    const out = fuse(s);

    // Baseline: the hardware stream alone through the same smoothing filter,
    // so the comparison isolates the gain from averaging two estimates.
    const a = (1 / HZ) / (smoothTau + 1 / HZ);
    const hv = [s.ax, s.ay, s.az];
    if (!hwSmooth) hwSmooth = [...hv];
    else for (let k = 0; k < 3; k++) hwSmooth[k] += a * (hv[k] - hwSmooth[k]);

    if (out.settled) {
      errFused.push(Math.hypot(out.x - m[0], out.y - m[1], out.z - m[2]));
      errHw.push(Math.hypot(hwSmooth[0] - m[0], hwSmooth[1] - m[1], hwSmooth[2] - m[2]));
    }
  }
  const rms = (v) => Math.sqrt(v.reduce((q, e) => q + e * e, 0) / v.length);
  return { fused: rms(errFused), hwOnly: rms(errHw) };
}

let failed = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failed++;
};

console.log('\nfusion vs hardware-only baseline:');
const clean = simulate();
const gain = (1 - clean.fused / clean.hwOnly) * 100;
check('fusing two estimates beats the better single sensor', gain > 15,
  `${clean.fused.toFixed(4)} vs ${clean.hwOnly.toFixed(4)} (${gain.toFixed(1)}% better)`);

console.log('\ngated spike rejection:');
const cleanOff = simulate({ despike: false });
const cost = (simulate({ despike: true }).fused / cleanOff.fused - 1) * 100;
check('costs ~nothing on clean data', Math.abs(cost) < 2, `${cost.toFixed(1)}% change`);

for (const rate of [0.005, 0.02]) {
  const off = simulate({ despike: false, spikeRate: rate });
  const on = simulate({ despike: true, spikeRate: rate });
  check(`rejects ${(rate * 100).toFixed(1)}% spikes`, on.fused < off.fused * 0.6,
    `${off.fused.toFixed(4)} -> ${on.fused.toFixed(4)}`);
}

console.log('\ngravity separation:');
const f = createFuser();
let last;
for (let i = 0; i < HZ * 5; i++) last = f({ t: (i / HZ) * 1000, x: 0, y: 0, z: G, ax: 0, ay: 0, az: 0 });
check('removes gravity from a still device', Math.abs(last.mag) < 0.01, `|a| = ${last.mag.toFixed(5)}`);
check('reports gravity magnitude correctly', Math.abs(last.gravityError) < 0.01,
  `error = ${last.gravityError.toFixed(5)}`);
check('settles within 3 time constants', last.settled === true);

console.log('\nsingle-sensor fallback:');
const f2 = createFuser();
let l2;
for (let i = 0; i < HZ * 5; i++) {
  l2 = f2({ t: (i / HZ) * 1000, x: 0, y: 0, z: G, ax: null, ay: null, az: null });
}
check('works with no hardware linear-accel stream', l2.sources === 1 && Math.abs(l2.mag) < 0.05,
  `sources=${l2.sources}, |a|=${l2.mag.toFixed(4)}`);

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
