// ANDROID capture path.
//
// Chrome/Android exposes the modern Generic Sensor API (`Accelerometer`,
// `LinearAccelerationSensor`) which lets us request an explicit frequency and
// read raw device-frame values. That is strictly better than devicemotion:
// higher and more stable rate, and no 60ms event coalescing.
//
// Falls back to `devicemotion` for Firefox/Android and older WebViews.
export const androidCapture = {
  id: 'android',

  supported() {
    return 'Accelerometer' in window || 'ondevicemotion' in window;
  },

  describe() {
    return 'Accelerometer' in window
      ? 'Generic Sensor API (Chrome/Android)'
      : 'devicemotion fallback';
  },

  // Android grants motion sensors via the Permissions API, and only over
  // a secure context. There is no user-gesture requirement.
  async requestPermission() {
    if (!('permissions' in navigator) || !('Accelerometer' in window)) {
      return { granted: true, note: 'no explicit permission needed' };
    }
    try {
      const results = await Promise.all([
        navigator.permissions.query({ name: 'accelerometer' }),
        navigator.permissions.query({ name: 'gyroscope' }).catch(() => null),
      ]);
      const accel = results[0];
      return {
        granted: accel.state !== 'denied',
        note: `accelerometer: ${accel.state}`,
      };
    } catch {
      // Some builds do not list 'accelerometer' as a queryable name.
      return { granted: true, note: 'permission query unsupported' };
    }
  },

  // `forceDeviceMotion` exists because the Generic Sensor API can be present
  // but blocked (Permissions-Policy, an embedded WebView), while `devicemotion`
  // still delivers. Callers that can retry use it as a fallback path.
  start(hz, emit, opts = {}) {
    if (!opts.forceDeviceMotion && 'Accelerometer' in window) return startSensorApi(hz, emit);
    return startDeviceMotion(emit);
  },
};

function startSensorApi(hz, emit) {
  // Raw includes gravity; linear excludes it. Streaming both is what makes
  // the data actually usable downstream (orientation vs. movement).
  const raw = new window.Accelerometer({ frequency: hz, referenceFrame: 'device' });
  let linear = null;
  if ('LinearAccelerationSensor' in window) {
    linear = new window.LinearAccelerationSensor({ frequency: hz });
    linear.addEventListener('error', () => { linear = null; });
    linear.start();
  }

  raw.addEventListener('reading', () => {
    emit({
      t: Date.now(),
      x: raw.x, y: raw.y, z: raw.z,
      ax: linear?.x ?? null, ay: linear?.y ?? null, az: linear?.z ?? null,
      src: 'sensor-api',
    });
  });

  let fatal = null;
  raw.addEventListener('error', (e) => { fatal = e.error?.message || 'sensor error'; });
  raw.start();

  return {
    stop() { raw.stop(); linear?.stop(); },
    error: () => fatal,
  };
}

function startDeviceMotion(emit) {
  const handler = (e) => {
    const g = e.accelerationIncludingGravity || {};
    const a = e.acceleration || {};
    emit({
      t: Date.now(),
      x: g.x ?? 0, y: g.y ?? 0, z: g.z ?? 0,
      ax: a.x ?? null, ay: a.y ?? null, az: a.z ?? null,
      src: 'devicemotion',
    });
  };
  window.addEventListener('devicemotion', handler);
  return {
    stop() { window.removeEventListener('devicemotion', handler); },
    error: () => null,
  };
}
