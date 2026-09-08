// Shared phone->laptop link. Auto-reconnects; drops samples rather than
// queueing them when the socket backs up, since stale motion data is useless.
export function createTransport({ onState, onOpen }) {
  let ws = null;
  let retry = 500;
  let dropped = 0;
  let sent = 0;

  function connect() {
    const params = new URLSearchParams(window.location.search);
    const session = params.get('session') || '';
    const token = params.get('token') || '';
    const q = new URLSearchParams();
    if (session) q.set('session', session);
    if (token) q.set('token', token);
    const qs = q.toString();
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${scheme}//${location.host}/phone` + (qs ? '?' + qs : ''));

    ws.onopen = () => {
      retry = 500;
      onState({ state: 'connected', sent, dropped });
      onOpen?.();
    };
    ws.onclose = () => {
      onState({ state: 'reconnecting', sent, dropped });
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 5000);
    };
    ws.onerror = () => ws.close();
  }

  connect();

  return {
    send(obj) {
      if (!ws || ws.readyState !== WebSocket.OPEN) { dropped++; return false; }
      // bufferedAmount guards against a slow link turning into unbounded lag
      if (ws.bufferedAmount > 64 * 1024) { dropped++; return false; }
      ws.send(JSON.stringify(obj));
      sent++;
      return true;
    },
    stats: () => ({ sent, dropped }),
  };
}
