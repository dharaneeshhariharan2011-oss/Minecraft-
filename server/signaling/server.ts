import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { parseClientMessage, ProtocolError, MAX_PAYLOAD_BYTES, type ServerMessage } from '../../shared/protocols/messages.js';
import { RoomError, RoomManager, type Sink } from './rooms.js';

export interface SignalingOptions {
  port?: number;
  host?: string;
  /** Directory containing the built client (index.html). Omitted or missing = API-only server. */
  distDir?: string;
  rooms?: RoomManager;
  /** Max messages per connection per second before the socket is closed. */
  maxMessagesPerSecond?: number;
  heartbeatMs?: number;
  log?: (line: string) => void;
}

export interface SignalingServer {
  http: Server;
  rooms: RoomManager;
  url(): string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

function serveStatic(distDir: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = resolve(distDir, rel || 'index.html');
  // Path traversal guard: the resolved file must stay inside distDir.
  if (file !== distDir && !file.startsWith(distDir + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA-style fallback for unknown paths without an extension.
    if (extname(rel) === '') file = join(distDir, 'index.html');
    else {
      res.writeHead(404).end('not found');
      return;
    }
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const cacheControl = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'content-type': type, 'cache-control': cacheControl });
  createReadStream(file).pipe(res);
}

/** Creates the HTTP + WebSocket signalling server. Call `listen` via the returned `http` server. */
export function createSignalingServer(options: SignalingOptions = {}): Promise<SignalingServer> {
  const rooms = options.rooms ?? new RoomManager();
  const maxRate = options.maxMessagesPerSecond ?? 120;
  const log = options.log ?? (() => {});
  const distDir = options.distDir ? resolve(options.distDir) : undefined;

  const http = createServer((req, res) => {
    if (req.url?.startsWith('/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: rooms.roomCount }));
      return;
    }
    if (distDir && existsSync(distDir)) {
      serveStatic(distDir, req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Minecraft by DH signaling server');
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_PAYLOAD_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws: WebSocket) => {
    const sink = wrapSocket(ws);
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    let windowStart = Date.now();
    let count = 0;

    ws.on('message', (data: RawData) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > maxRate) {
        sink.send({ type: 'error', code: 'rate_limited', message: 'too many messages' });
        ws.close(1008, 'rate limited');
        return;
      }
      void handle(sink, data);
    });

    ws.on('close', () => {
      // Keep the player's seat for the reconnect grace period; they can resume with their token.
      rooms.disconnect(sink);
    });
    ws.on('error', () => {
      rooms.disconnect(sink);
    });

    async function handle(s: Sink, data: RawData): Promise<void> {
      try {
        const msg = parseClientMessage(toBuffer(data));
        switch (msg.type) {
          case 'host':
            if (msg.protocol < 1) throw new RoomError('protocol', 'client protocol too old');
            rooms.createRoom(s, msg.name, msg.accountId);
            break;
          case 'join':
            rooms.joinRoom(s, msg.code, msg.name, msg.accountId);
            break;
          case 'resume':
            rooms.beginResume(s, msg.code, msg.playerId);
            break;
          case 'proof':
            await rooms.completeResume(s, msg.proof);
            break;
          case 'rtc':
            rooms.routeRtc(s, msg.to, msg.payload);
            break;
          case 'relay':
            rooms.routeRelay(s, msg.to, msg.payload);
            break;
          case 'admin':
            rooms.admin(s, msg.action, msg.target, msg.role);
            break;
          case 'chat':
            rooms.chat(s, msg.text);
            break;
          case 'ping':
            s.send({ type: 'pong', t: msg.t });
            break;
          case 'leave':
            rooms.leave(s);
            break;
        }
      } catch (err) {
        if (err instanceof RoomError) {
          s.send({ type: 'error', code: err.code, message: err.message });
        } else if (err instanceof ProtocolError) {
          s.send({ type: 'error', code: 'bad_request', message: err.message });
        } else {
          log(`internal error: ${String(err)}`);
          s.send({ type: 'error', code: 'internal', message: 'internal server error' });
        }
      }
    }
  });

  // Heartbeat: terminate sockets that stopped answering pings.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, options.heartbeatMs ?? 20_000);
  heartbeat.unref();

  return new Promise((resolvePromise, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 8080, options.host ?? '0.0.0.0', () => {
      http.removeListener('error', reject);
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : options.port ?? 8080;
      resolvePromise({
        http,
        rooms,
        url: () => `ws://127.0.0.1:${port}/ws`,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const client of wss.clients) client.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}

function wrapSocket(ws: WebSocket): Sink {
  const id = randomUUID();
  return {
    id,
    send(msg: ServerMessage) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close(reason?: string) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, reason ?? 'closed');
    },
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
