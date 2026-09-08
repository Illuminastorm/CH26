const $ = (id) => document.getElementById(id);
const sensorButton = $('sensorButton');
const phoneLight = $('phoneLight');
const phoneStatus = $('phoneStatus');
const linkState = $('linkState');
const notice = $('notice');
const route = new URLSearchParams(location.search);
const roomId = route.get('room');
const player = Number(route.get('player'));
let socket = null;
let streaming = false;
let stopped = false;
let retryMs = 500;
let lastSampleAt = 0;

if (!roomId || (player !== 1 && player !== 2)) location.replace('/link-expired.html');

function endpoint(path) {
  return `${path}?room=${encodeURIComponent(roomId)}&player=${player}`;
}

function setLink(message, tone = '') {
  phoneStatus.textContent = message;
  phoneLight.className = `indicator ${tone}`;
}

function setNotice(message, tone = '') {
  notice.textContent = message;
  notice.className = `notice ${tone}`;
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function validAxes(value) {
  return value && ['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]));
}

function onMotion(event) {
  const now = performance.now();
  if (now - lastSampleAt < 1000 / 60) return;
  const raw = validAxes(event.accelerationIncludingGravity)
    ? event.accelerationIncludingGravity
    : validAxes(event.acceleration) ? event.acceleration : null;
  if (!raw) {
    setNotice('MOTION SENSOR HAS NOT PROVIDED AXIS VALUES YET.', 'warn');
    return;
  }
  lastSampleAt = now;
  const sample = { type: 'sample', x: raw.x, y: raw.y, z: raw.z };
  if (validAxes(event.acceleration)) {
    sample.ax = event.acceleration.x;
    sample.ay = event.acceleration.y;
    sample.az = event.acceleration.z;
  }
  if (!send(sample)) {
    pauseForReconnect();
    setNotice('SENSOR IS PAUSED UNTIL THE SECURE LINK RECONNECTS.', 'warn');
    return;
  }
  for (const axis of ['x', 'y', 'z']) $(`${axis}`).textContent = Number(sample[axis]).toFixed(2);
}

function startStreaming() {
  if (stopped || socket?.readyState !== WebSocket.OPEN) {
    sensorButton.disabled = true;
    setNotice('PHONE LINK IS NOT READY. WAIT FOR A SECURE CONNECTION.', 'warn');
    return;
  }
  streaming = true;
  lastSampleAt = 0;
  window.addEventListener('devicemotion', onMotion, { passive: true });
  sensorButton.textContent = 'STOP SENSOR';
  if (!send({ type: 'stream', active: true })) {
    pauseForReconnect();
    setNotice('SENSOR IS PAUSED UNTIL THE SECURE LINK RECONNECTS.', 'warn');
    return;
  }
  setNotice('SENSOR STREAM ACTIVE. KEEP THIS PAGE OPEN WHILE PLAYING.', 'good');
}

function stopStreaming() {
  streaming = false;
  window.removeEventListener('devicemotion', onMotion);
  sensorButton.textContent = 'START SENSOR';
  send({ type: 'stream', active: false });
  setNotice('SENSOR STREAM STOPPED.', 'warn');
}

function pauseForReconnect() {
  if (!streaming) return;
  streaming = false;
  window.removeEventListener('devicemotion', onMotion);
  sensorButton.textContent = 'START SENSOR';
}

function invalidateLink(message) {
  stopped = true;
  pauseForReconnect();
  setLink('PHONE LINK CLOSED', 'bad');
  linkState.textContent = 'LINK NO LONGER VALID';
  sensorButton.disabled = true;
  setNotice(message, 'bad');
}

async function phoneSessionValidity() {
  try {
    const response = await fetch(endpoint('/api/phone-session'), { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) return false;
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

function requestSensorPermission() {
  if (typeof window.DeviceMotionEvent === 'undefined') return Promise.reject(new Error('unsupported'));
  if (typeof window.DeviceMotionEvent.requestPermission === 'function') {
    // This invocation stays directly inside the tap handler for iOS.
    return window.DeviceMotionEvent.requestPermission();
  }
  return Promise.resolve('granted');
}

sensorButton.addEventListener('click', () => {
  if (streaming) {
    stopStreaming();
    return;
  }
  sensorButton.disabled = true;
  setNotice('REQUESTING MOTION ACCESS.', 'warn');
  requestSensorPermission().then((result) => {
    if (result !== 'granted') throw new Error('denied');
    startStreaming();
  }).catch(() => {
    if (!stopped) setNotice('MOTION ACCESS WAS NOT GRANTED. CHECK BROWSER PERMISSIONS.', 'bad');
  }).finally(() => {
    sensorButton.disabled = stopped || socket?.readyState !== WebSocket.OPEN;
  });
});

function scheduleRetry() {
  if (stopped) return;
  window.setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 5_000);
}

function connect() {
  if (stopped) return;
  setLink('CONNECTING PHONE', 'warn');
  sensorButton.disabled = true;
  try {
    socket = new WebSocket(`wss://${location.host}/ws/phone?room=${encodeURIComponent(roomId)}&player=${player}`);
  } catch {
    scheduleRetry();
    return;
  }
  const activeSocket = socket;
  activeSocket.onopen = () => {
    retryMs = 500;
    setLink('PHONE LINK READY', 'good');
    linkState.textContent = 'SECURE LINK ACCEPTED';
    sensorButton.disabled = false;
  };
  activeSocket.onerror = () => {
    if (activeSocket.readyState === WebSocket.OPEN) activeSocket.close();
  };
  activeSocket.onclose = async (event) => {
    if (stopped || activeSocket !== socket) return;
    if (event.code === 1001 || event.code === 1008) {
      invalidateLink('ASK THE HOST FOR A NEW PLAYER LINK.');
      return;
    }
    pauseForReconnect();
    if (await phoneSessionValidity() === false) {
      invalidateLink('ASK THE HOST FOR A NEW PLAYER LINK.');
      return;
    }
    setLink('PHONE RECONNECTING', 'warn');
    setNotice('SENSOR IS PAUSED UNTIL THE SECURE LINK RECONNECTS.', 'warn');
    scheduleRetry();
  };
}

async function loadSession() {
  try {
    const response = await fetch(endpoint('/api/phone-session'), { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('session unavailable');
    const session = await response.json();
    if (session.roomId !== roomId || Number(session.player) !== player) throw new Error('session mismatch');
    $('roomId').textContent = roomId;
    $('playerSlot').textContent = `PLAYER ${player}`;
    linkState.textContent = 'SECURE LINK ACCEPTED';
    setNotice('CONNECTING TO THE ROOM. PRESS START WHEN READY.', 'good');
    connect();
  } catch {
    setLink('LINK INVALID', 'bad');
    linkState.textContent = 'LINK EXPIRED OR USED';
    setNotice('ASK THE HOST FOR A NEW PLAYER LINK.', 'bad');
  }
}

window.addEventListener('pagehide', () => {
  stopped = true;
  if (streaming) stopStreaming();
  socket?.close();
});
loadSession();
