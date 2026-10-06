// The WebSocket side: who is connected, the token check, and routing each message to a handler.
// Handlers live in ./routes/*.mjs; each exports `{ handlers: { [type]: (msg, conn) => ... }, onClose?(conn), fallback?(msg, conn) }`.

import { WebSocketServer } from 'ws';
import { TOKEN, hostOk, origins, safeEqual } from './config.mjs';

/** Everyone connected, and a way to tell all of them something. */
export function createHub() {
  const clients = new Set();
  return {
    clients,
    broadcast(msg) {
      const data = JSON.stringify(msg);
      for (const ws of clients) if (ws.readyState === 1) ws.send(data);
    },
  };
}

/** Merge several route modules into one. */
export function combineRoutes(...parts) {
  const handlers = Object.assign({}, ...parts.map((p) => p.handlers || {}));
  return {
    handlers,
    onClose: (conn) => parts.forEach((p) => p.onClose?.(conn)),
    fallback: async (m, conn) => { for (const p of parts) if (p.fallback && (await p.fallback(m, conn)) !== false) return; },
  };
}

export function attachWebSocket(server, { hub, routes, snapshot }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const ok =
      url.pathname === '/ws' &&
      hostOk(req) &&
      req.headers.origin !== undefined &&
      origins.has(req.headers.origin) &&
      safeEqual(url.searchParams.get('token') || '', TOKEN);
    if (!ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    hub.clients.add(ws);
    // `conn` is this one browser connection; routes keep their per-connection state (such as a terminal) on it.
    const conn = { ws, send: (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } };
    const gone = () => { hub.clients.delete(ws); routes.onClose(conn); };
    ws.on('close', gone);
    ws.on('error', gone);
    conn.send(snapshot({ clone: true }));

    ws.on('message', async (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!m || typeof m.t !== 'string') return;
      try {
        const handler = routes.handlers[m.t];
        if (handler) await handler(m, conn);
        else await routes.fallback(m, conn);
      } catch (e) {
        conn.send({ t: 'notice', text: e.message });
      }
    });
  });
  return wss;
}
