import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { createApp, type App } from "../server/app";
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "../shared/protocol";

export interface Running {
  app: App;
  origin: string;
  wsUrl: string;
  dataDir: string;
  stop(keepData?: boolean): Promise<void>;
}

export async function start(dataDir = mkdtempSync(path.join(tmpdir(), "inkwell-test-")), limits?: { boardsPerHourPerIp?: number; connectionsPerIp?: number }): Promise<Running> {
  const app = createApp({ dataDir, allowedOrigins: [], limits });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    origin: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    dataDir,
    async stop(keepData = false) {
      await app.close();
      if (!keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function createBoard(r: Running): Promise<{ id: string; editKey: string; viewKey: string }> {
  const res = await fetch(`${r.origin}/api/boards`, { method: "POST", headers: { Origin: r.origin } });
  if (res.status !== 201) throw new Error(`create board: ${res.status}`);
  return res.json();
}

/** A minimal Inkwell client: authenticates, then syncs a Y.Doc and presence. */
export class Client {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  role: "edit" | "view" | null = null;
  closeCode: number | null = null;
  private ws: WebSocket;
  readonly opened: Promise<void>;

  constructor(url: string, origin: string | undefined, auth: { board: string; key: string } | null) {
    this.ws = new WebSocket(url, origin ? { origin } : {});
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.ws.once("error", reject);
      this.ws.on("close", (code) => {
        this.closeCode = code;
        resolve();
      });
      this.ws.on("open", () => {
        if (auth) this.ws.send(JSON.stringify({ type: "auth", ...auth }));
      });
      this.ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ready") {
            this.role = msg.role;
            // Ask the server for everything we're missing, as real Yjs clients do.
            const e = encoding.createEncoder();
            encoding.writeVarUint(e, MESSAGE_SYNC);
            syncProtocol.writeSyncStep1(e, this.doc);
            this.sendRaw(encoding.toUint8Array(e));
            resolve();
          }
          return;
        }
        this.handle(new Uint8Array(data as Buffer));
      });
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.sendRaw(encoding.toUint8Array(e));
    });
  }

  private handle(data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
      if (encoding.length(reply) > 1) this.sendRaw(encoding.toUint8Array(reply));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  sendRaw(data: Uint8Array | string) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  sendAwareness(state: unknown, clientId = this.doc.clientID, clock = 1) {
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, clientId);
    encoding.writeVarUint(update, clock);
    encoding.writeVarString(update, JSON.stringify(state));
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(e, encoding.toUint8Array(update));
    this.sendRaw(encoding.toUint8Array(e));
  }

  get elements() {
    return this.doc.getMap("elements");
  }

  close() {
    this.ws.close();
  }

  waitClosed(): Promise<number> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve(this.closeCode ?? 0);
    return new Promise((resolve) => this.ws.once("close", (code) => resolve(code)));
  }
}

export async function connect(r: Running, board: string, key: string): Promise<Client> {
  const c = new Client(r.wsUrl, r.origin, { board, key });
  await c.opened;
  return c;
}

export async function eventually(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const stroke = (id: string, z = 1) => ({ id, type: "stroke", color: "#2563eb", width: 4, points: [0, 0, 10, 10], z });
