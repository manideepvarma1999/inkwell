import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { BOARD_ID, BOARD_KEY, CLOSE, type AuthMessage, type AuthResult } from "../shared/protocol";
import { LIMITS } from "../shared/schema";
import { Room } from "./rooms";
import { BoardStore } from "./store";

export interface AppConfig {
  dataDir: string;
  /** Origins allowed to open WebSockets. Same-origin requests are always allowed. */
  allowedOrigins: string[];
  /** Built frontend to serve; omit in development (Vite serves it). */
  staticDir?: string;
  trustProxy?: boolean;
  limits?: { boardsPerHourPerIp?: number; connectionsPerIp?: number };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", // board keys live in the URL fragment; never leak the page URL
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

export interface App {
  server: Server;
  store: BoardStore;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

export function createApp(config: AppConfig): App {
  const store = new BoardStore(config.dataDir);
  const rooms = new Map<string, Room>();
  const boardsPerHour = config.limits?.boardsPerHourPerIp ?? 30;
  const connectionsPerIp = config.limits?.connectionsPerIp ?? 20;
  const creations = new Map<string, number[]>();
  const connectionsByIp = new Map<string, number>();

  const clientIp = (req: IncomingMessage) => {
    if (config.trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname === "/api/boards") return createBoard(req, res);
      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { status: "ok" });
      if (req.method === "GET" && config.staticDir) return serveStatic(config.staticDir, url.pathname, res);
      json(res, 404, { error: "not found" });
    } catch {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });

  function createBoard(req: IncomingMessage, res: ServerResponse) {
    if (!isAllowedOrigin(req, config.allowedOrigins)) return json(res, 403, { error: "origin not allowed" });
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (creations.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= boardsPerHour) return json(res, 429, { error: "too many boards created; try again later" });
    recent.push(now);
    if (creations.size > 10_000) creations.clear();
    creations.set(ip, recent);
    res.setHeader("Cache-Control", "no-store");
    json(res, 201, store.create());
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });

  server.on("upgrade", (req, socket, head) => {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") return reject(404, "Not Found");
    // Browsers always send Origin on WebSocket upgrades; checking it stops other sites
    // from opening sockets with a visitor's browser (cross-site WebSocket hijacking).
    if (!isAllowedOrigin(req, config.allowedOrigins)) return reject(403, "Forbidden");
    const ip = clientIp(req);
    if ((connectionsByIp.get(ip) ?? 0) >= connectionsPerIp) return reject(429, "Too Many Requests");

    wss.handleUpgrade(req, socket, head, (ws) => {
      connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
      ws.once("close", () => {
        const n = (connectionsByIp.get(ip) ?? 1) - 1;
        if (n <= 0) connectionsByIp.delete(ip);
        else connectionsByIp.set(ip, n);
      });
      handleConnection(ws);
    });
  });

  function handleConnection(ws: WebSocket) {
    let room: Room | undefined;
    let alive = true;
    const authTimer = setTimeout(() => ws.close(CLOSE.authTimeout, "authenticate first"), 5000);
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on("pong", () => (alive = true));

    ws.on("message", (data, isBinary) => {
      const bytes = toBytes(data);
      if (!room) {
        // The first message must be the JSON auth frame.
        clearTimeout(authTimer);
        if (isBinary || bytes.length > 512) return ws.close(CLOSE.unauthorized, "unauthorized");
        let auth: AuthMessage;
        try {
          auth = JSON.parse(Buffer.from(bytes).toString("utf8"));
        } catch {
          return ws.close(CLOSE.unauthorized, "unauthorized");
        }
        if (auth?.type !== "auth" || typeof auth.board !== "string" || typeof auth.key !== "string" ||
            !BOARD_ID.test(auth.board) || !BOARD_KEY.test(auth.key)) {
          return ws.close(CLOSE.unauthorized, "unauthorized");
        }
        const role = store.authorize(auth.board, auth.key);
        if (!role) return ws.close(CLOSE.unauthorized, "unauthorized");

        let target = rooms.get(auth.board);
        if (!target) {
          target = new Room(auth.board, store, (empty) => {
            // Keep a briefly idle room in memory in case someone reconnects.
            setTimeout(() => {
              if (empty.conns.size === 0 && rooms.get(empty.id) === empty) {
                rooms.delete(empty.id);
                empty.destroy();
              }
            }, 30_000).unref();
          });
          rooms.set(auth.board, target);
        }
        if (target.conns.size >= LIMITS.maxConnectionsPerBoard) return ws.close(CLOSE.tooManyConnections, "board is full");
        room = target;
        const ready: AuthResult = { type: "ready", role };
        ws.send(JSON.stringify(ready));
        room.join(ws, role);
        return;
      }
      if (!isBinary) return ws.close(CLOSE.badMessage, "bad message");
      const closeCode = room.receive(ws, bytes);
      if (closeCode) ws.close(closeCode, "connection closed by server");
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      room?.leave(ws);
    });
    ws.on("error", () => ws.terminate());
  }

  return {
    server,
    store,
    rooms,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      for (const room of rooms.values()) {
        room.save();
        room.destroy();
      }
      rooms.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

function isAllowedOrigin(req: IncomingMessage, allowed: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return false; // browsers always send Origin on these requests
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function serveStatic(root: string, pathname: string, res: ServerResponse) {
  const decoded = decodeURIComponent(pathname);
  let file = path.normalize(path.join(root, decoded));
  // Block path traversal outside the static directory.
  if (!file.startsWith(path.normalize(root + path.sep)) && file !== path.normalize(root)) return json(res, 400, { error: "bad path" });
  if (decoded === "/" || decoded.startsWith("/b/") || !path.extname(file)) file = path.join(root, "index.html");
  try {
    const body = await readFile(file);
    res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
    res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    res.writeHead(200).end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function toBytes(data: unknown): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data as Buffer);
}
