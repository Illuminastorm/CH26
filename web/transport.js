// Shared phone->laptop link. Auto-reconnects; drops samples rather than
// queueing them when the socket backs up, since stale motion data is useless.
export function createTransport({ onState, onOpen }) {
  let ws = null;
  let retry = 500;
  let dropped = 0;
  let sent = 0;

  function connect() {
    ws = new WebSocket(`wss://${location.host}/phone`);

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
