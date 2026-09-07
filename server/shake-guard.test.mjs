import { createShakeGuard } from './shake-guard.mjs';

let failed = 0;
const check = (name, pass) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
};

console.log('\ncontinuous-shake guard:');
const shake = createShakeGuard();
let caught = false;
let detections = 0;
for (let i = 0; i < 60; i++) {
  const t = i * 1000 / 60;
  // 5 Hz, 9 m/s² back-and-forth motion along the phone's local Y axis.
  const result = shake({ t, x: 0, y: 9 * Math.sin(2 * Math.PI * 5 * t / 1000), z: 0 });
  caught ||= result.blocked;
  detections += Number(result.detected);
}
check('blocks sustained alternating up/down motion', caught);
check('emits one detection during the cooldown period', detections === 1);

const punch = createShakeGuard();
let wronglyBlocked = false;
const impulse = [0, 3, 16, 8, -9, -3, 0, 0, 0, 0];
for (let i = 0; i < impulse.length; i++) {
  wronglyBlocked ||= punch({ t: i * 35, x: 0, y: impulse[i], z: 0 }).blocked;
}
check('allows one punch and its natural deceleration', !wronglyBlocked);

const pullback = createShakeGuard();
let pullbackBlocked = false;
// A hard punch, recoil, and a couple of return movements can legitimately
// create four strong lobes.  They are not the sustained cadence of a shake.
const pullbackMotion = [12, -10, 8, -7, 0, 0, 0];
for (let i = 0; i < pullbackMotion.length; i++) {
  pullbackBlocked ||= pullback({ t: i * 110, x: 0, y: pullbackMotion[i], z: 0 }).blocked;
}
check('allows a punch with a short pullback sequence', !pullbackBlocked);

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
