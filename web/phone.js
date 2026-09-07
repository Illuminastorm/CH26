import { createTransport } from '/transport.js';
import { androidCapture } from '/capture-android.js';
import { iosCapture } from '/capture-ios.js';

const TARGET_HZ = 60;
const $ = (id) => document.getElementById(id);

// iOS is identified by the requestPermission hook rather than the UA string,
// which iPadOS deliberately makes unreliable.
function detect() {
  const iosLike = typeof window.DeviceMotionEvent?.requestPermission === 'function';
  if (iosLike) return iosCapture;
  if (androidCapture.supported()) return androidCapture;
  return iosCapture.supported() ? iosCapture : null;
}

let impl = detect();
let session = null;
let transport = null;
const playerSlot = () => Number($('player').value);

$('pick').onchange = (e) => {
  const v = e.target.value;
  impl = v === 'android' ? androidCapture : v === 'ios' ? iosCapture : detect();
  refreshImpl();
};

function refreshImpl() {
  $('impl').textContent = impl ? `${impl.id} — ${impl.describe()}` : 'unsupported';
}
refreshImpl();

function note(text, ok = false) {
  $('note').textContent = text;
  $('note').className = ok ? 'ok' : '';
}

if (!window.isSecureContext) {
  note('Not a secure context — open the https:// address, not http://.');
}

transport = createTransport({
  onState: ({ state }) => { $('link').textContent = state; },
  onOpen: () => {
    // A player can tap Start while the socket is reconnecting. Reannounce the
    // active capture session when it returns so the laptop never treats a
    // stream as idle simply because its first packet was dropped.
    if (session) announceStreaming();
  },
});

function announceStreaming() {
  transport.send({
    type: 'hello', platform: impl.id, impl: impl.describe(),
    ua: navigator.userAgent, hz: TARGET_HZ, player: playerSlot(),
  });
  transport.send({ type: 'streaming', active: true });
}

// The click handler stays synchronous up to requestPermission(): iOS rejects
// the prompt if an await happens before it inside the gesture.
$('go').onclick = () => {
  if (session) { stop(); return; }
  if (!impl) { note('No accelerometer API available in this browser.'); return; }

  const permission = impl.requestPermission();
  $('go').disabled = true;

  permission.then(({ granted, note: why }) => {
    $('go').disabled = false;
    if (!granted) { note(why); return; }
    note(why || 'streaming', true);
    start();
  });
};

let count = 0;
let windowStart = performance.now();

function start() {
  $('player').disabled = true;

  session = impl.start(TARGET_HZ, (sample) => {
    transport.send({ type: 'accel', ...sample });

    $('x').textContent = sample.x.toFixed(2);
    $('y').textContent = sample.y.toFixed(2);
    $('z').textContent = sample.z.toFixed(2);
    $('src').textContent = sample.src;

    if (++count % 20 === 0) {
      const now = performance.now();
      $('hz').textContent = `${(20000 / (now - windowStart)).toFixed(0)} Hz`;
      windowStart = now;
      const { sent, dropped } = transport.stats();
      $('counts').textContent = `${sent} / ${dropped}`;
      const err = session.error();
      if (err) note(err);
    }
  });
  // The bridge deliberately distinguishes an open phone page from an active
  // sensor stream, so the game cannot start a guaranteed 0.0 round before
  // the player has granted motion access and capture is running.
  announceStreaming();

  $('go').textContent = 'Stop';
  // Sleeping mid-capture kills the stream silently; warn rather than pretend.
  document.addEventListener('visibilitychange', onHide);
}

function onHide() {
  if (document.hidden) {
    transport.send({ type: 'streaming', active: false });
    note('Screen off / app backgrounded — sensors are paused by the OS.');
  } else if (session) {
    announceStreaming();
  }
}

function stop() {
  transport.send({ type: 'streaming', active: false });
  session.stop();
  session = null;
  document.removeEventListener('visibilitychange', onHide);
  $('go').textContent = 'Start streaming';
  $('player').disabled = false;
  note('stopped');
}
