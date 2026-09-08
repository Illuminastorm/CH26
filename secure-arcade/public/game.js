const $ = (id) => document.getElementById(id);
const monitorLight = $('monitorLight');
const monitorStatus = $('monitorStatus');
const notice = $('notice');
const roomId = new URLSearchParams(location.search).get('room');
let socket = null;
let stopped = false;
let retryMs = 500;

if (!roomId) location.replace('/');
$('roomId').textContent = roomId || 'ROOM UNAVAILABLE';
$('backToLobby').href = `/lobby.html?room=${encodeURIComponent(roomId || '')}`;

function endpoint(path) {
  return `${path}?room=${encodeURIComponent(roomId)}`;
}

function setLink(message, tone = '') {
  monitorStatus.textContent = message;
  monitorLight.className = `indicator ${tone}`;
}

function setNotice(message, tone = '') {
  notice.textContent = message;
  notice.className = `notice ${tone}`;
}

function setPlayerStatus(player, state) {
  const header = $(`fighterState${player}`);
  const panel = $(`fighter${player}`);
  if (state.streaming) {
    header.textContent = 'STREAMING';
    header.className = 'fighter-state good';
    panel.classList.add('streaming');
  } else if (state.connected) {
    header.textContent = 'PHONE LINKED';
    header.className = 'fighter-state warn';
    panel.classList.remove('streaming');
  } else {
    header.textContent = 'WAITING';
    header.className = 'fighter-state';
    panel.classList.remove('streaming');
  }
}

function showSample(sample) {
  const player = Number(sample.player);
  if (player !== 1 && player !== 2) return;
  for (const axis of ['x', 'y', 'z']) {
    const value = Number(sample[axis]);
    if (!Number.isFinite(value)) return;
    $(`${axis}${player}`).textContent = value.toFixed(2);
  }
  const power = Math.hypot(sample.x, sample.y, sample.z);
  $(`powerText${player}`).textContent = `${power.toFixed(2)} m/s2`;
  $(`power${player}`).style.width = `${Math.min(100, (power / 24) * 100).toFixed(1)}%`;
}

function handleMessage(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === 'status') {
    if (message.roomId) $('roomId').textContent = message.roomId;
    for (let i = 0; i < 2; i++) setPlayerStatus(i + 1, message.players?.[i] || {});
    return;
  }
  if (message.type === 'sample') showSample(message);
}

async function hostSessionValidity() {
  try {
    const response = await fetch(endpoint('/api/session'), { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) return false;
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

function endMonitor(message) {
  stopped = true;
  setLink('SESSION ENDED', 'bad');
  setNotice(message, 'bad');
}

function connect() {
  if (stopped) return;
  setLink('CONNECTING MONITOR', 'warn');
  try {
    socket = new WebSocket(`wss://${location.host}/ws/monitor?room=${encodeURIComponent(roomId)}`);
  } catch {
    scheduleRetry();
    return;
  }
  const activeSocket = socket;
  activeSocket.onopen = () => {
    retryMs = 500;
    setLink('ROOM MONITOR ONLINE', 'good');
    setNotice('ONLY NEW SAMPLES ARE SHOWN. NO PRIOR SENSOR DATA IS LOADED.', 'good');
  };
  activeSocket.onmessage = handleMessage;
  activeSocket.onerror = () => {
    if (activeSocket.readyState === WebSocket.OPEN) activeSocket.close();
  };
  activeSocket.onclose = async (event) => {
    if (stopped || activeSocket !== socket) return;
    if (event.code === 1001 || event.code === 1008) {
      endMonitor('THIS ROOM SESSION IS CLOSED. RETURN TO THE ROOM CONSOLE.');
      return;
    }
    if (await hostSessionValidity() === false) {
      endMonitor('HOST ACCESS EXPIRED. RETURN TO THE ROOM CONSOLE.');
      return;
    }
    setLink('MONITOR RECONNECTING', 'warn');
    scheduleRetry();
  };
}

function scheduleRetry() {
  if (stopped) return;
  window.setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 5_000);
}

window.addEventListener('pagehide', () => {
  stopped = true;
  socket?.close();
});
connect();
