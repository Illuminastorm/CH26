// iOS / SAFARI capture path.
//
// iOS has no Generic Sensor API at all — `devicemotion` is the only route.
// Three constraints shape this file, and each one silently produces zero
// samples if you get it wrong:
//   1. Secure context (HTTPS) is mandatory.
//   2. `DeviceMotionEvent.requestPermission()` must be called from inside a
//      real user gesture (a tap). Calling it on page load is rejected.
//   3. iOS sign-flips accelerationIncludingGravity relative to the spec that
//      Android follows, so we negate to keep both platforms consistent.
//
// Rate is fixed by the OS (~60Hz in Safari, sometimes 30Hz in low power mode);
// a requested frequency cannot be honoured here, only reported.
export const iosCapture = {
  id: 'ios',

  supported() {
    return typeof window.DeviceMotionEvent !== 'undefined';
  },

  describe() {
    return needsExplicitGrant()
      ? 'devicemotion (iOS 13+, tap-to-grant)'
      : 'devicemotion (legacy iOS)';
  },

  // MUST be invoked synchronously from a tap handler.
  async requestPermission() {
    if (!needsExplicitGrant()) {
      return { granted: true, note: 'legacy iOS, no prompt' };
    }
    try {
      const state = await window.DeviceMotionEvent.requestPermission();
      return {
        granted: state === 'granted',
        note: state === 'granted'
          ? 'motion access granted'
          : 'denied — re-enable via Settings > Safari > Motion & Orientation Access',
      };
    } catch (err) {
      // Thrown when not called from a user gesture, or not a secure context.
      return {
        granted: false,
        note: `${err.message} (must be HTTPS + triggered by a tap)`,
      };
    }
  },

  start(_hz, emit) {
    let fatal = null;
    let seen = false;

    const handler = (e) => {
      seen = true;
      const g = e.accelerationIncludingGravity || {};
      const a = e.acceleration || {};
      // Normalise iOS sign convention to match Android's.
      emit({
        t: Date.now(),
        x: -(g.x ?? 0), y: -(g.y ?? 0), z: -(g.z ?? 0),
        ax: a.x == null ? null : -a.x,
        ay: a.y == null ? null : -a.y,
        az: a.z == null ? null : -a.z,
        src: 'devicemotion-ios',
        interval: e.interval ?? null,
      });
    };

    window.addEventListener('devicemotion', handler);

    // Permission can be "granted" yet still deliver nothing (Lockdown Mode,
    // an embedded WebView). Surface that instead of showing a dead readout.
    const watchdog = setTimeout(() => {
      if (!seen) fatal = 'permission granted but no motion events arrived — ' +
                         'check Lockdown Mode, or open in Safari rather than an in-app browser';
    }, 2000);

    return {
      stop() { clearTimeout(watchdog); window.removeEventListener('devicemotion', handler); },
      error: () => fatal,
    };
  },
};

function needsExplicitGrant() {
  return typeof window.DeviceMotionEvent?.requestPermission === 'function';
}
