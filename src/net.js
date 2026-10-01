// WebSocket link to the local Tandem server, with automatic reconnect.
export function createNet({ onMessage, onStatus }) {
  let ws = null;
  let retry = 0;
  let timer = null;

  async function connect() {
    clearTimeout(timer);
    try {
      const res = await fetch('/api/session', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const session = await res.json();
      onStatus('session', session);
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(session.token)}`);
      ws.onopen = () => {
        retry = 0;
        onStatus('open');
      };
      ws.onmessage = (e) => {
        try {
          onMessage(JSON.parse(e.data));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        onStatus('closed');
        schedule();
      };
      ws.onerror = () => {};
    } catch {
      onStatus('closed');
      schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    retry = Math.min(retry + 1, 6);
    timer = setTimeout(connect, 600 * retry);
  }

  return {
    connect,
    send(msg) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
    get open() {
      return !!ws && ws.readyState === 1;
    },
  };
}
