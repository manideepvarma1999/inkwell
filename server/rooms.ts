import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { CLOSE, MESSAGE_AWARENESS, MESSAGE_SYNC } from "../shared/protocol";
import { LIMITS, validateElement } from "../shared/schema";
import { checkAwarenessUpdate } from "./awareness-guard";
import type { BoardStore, Role } from "./store";

const SANITIZE = Symbol("server-sanitize");

interface Connection {
  role: Role;
  awarenessIds: Set<number>;
  tokens: number;
  lastRefill: number;
}

const RATE = { perSecond: 60, burst: 240 };

/** One board being edited: its Yjs document, presence, and connected sockets. */
export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Map<WebSocket, Connection>();
  private saveTimer: NodeJS.Timeout | undefined;
  private approxBytes: number;
  private destroyed = false;

  constructor(
    readonly id: string,
    private store: BoardStore,
    private onEmpty: (room: Room) => void,
  ) {
    this.awareness.setLocalState(null); // the server has no presence of its own
    const saved = store.load(id);
    if (saved) Y.applyUpdate(this.doc, saved, SANITIZE);
    this.approxBytes = saved?.length ?? 0;

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.approxBytes += update.length;
      this.broadcast(syncMessage((e) => syncProtocol.writeUpdate(e, update)));
      this.scheduleSave();
      if (origin !== SANITIZE) this.sanitize();
    });

    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const conn = origin as WebSocket | null;
      if (conn && this.conns.has(conn)) {
        const owned = this.conns.get(conn)!.awarenessIds;
        added.forEach((id) => owned.add(id));
        removed.forEach((id) => owned.delete(id));
      }
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(message, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(message));
    });
  }

  get elements(): Y.Map<unknown> {
    return this.doc.getMap("elements");
  }

  join(ws: WebSocket, role: Role): void {
    this.conns.set(ws, { role, awarenessIds: new Set(), tokens: RATE.burst, lastRefill: Date.now() });
    // Start the sync handshake and send everyone's presence.
    send(ws, syncMessage((e) => syncProtocol.writeSyncStep1(e, this.doc)));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(message, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      send(ws, encoding.toUint8Array(message));
    }
  }

  leave(ws: WebSocket): void {
    const conn = this.conns.get(ws);
    if (!conn || this.destroyed) return;
    this.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessIds], null);
    if (this.conns.size === 0) {
      this.save();
      this.onEmpty(this);
    }
  }

  /** Handle one binary message. Returns a close code if the connection must be dropped. */
  receive(ws: WebSocket, data: Uint8Array): number | null {
    const conn = this.conns.get(ws);
    if (!conn) return CLOSE.badMessage;
    if (!this.takeToken(conn)) return CLOSE.rateLimited;
    if (data.length > LIMITS.maxMessageBytes) return CLOSE.boardFull;

    try {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);

      if (type === MESSAGE_SYNC) {
        const syncType = decoding.readVarUint(decoder);
        if (syncType === syncProtocol.messageYjsSyncStep1) {
          // Anyone may ask for the document.
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, MESSAGE_SYNC);
          syncProtocol.readSyncStep1(decoder, reply, this.doc);
          send(ws, encoding.toUint8Array(reply));
          return null;
        }
        if (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) {
          if (conn.role !== "edit") return null; // read-only: changes from viewers are dropped
          const update = decoding.readVarUint8Array(decoder);
          if (!this.hasRoomFor(update.length)) return CLOSE.boardFull;
          Y.applyUpdate(this.doc, update, ws);
          return null;
        }
        return CLOSE.badMessage;
      }

      if (type === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        const ids = checkAwarenessUpdate(update, conn.awarenessIds, (id) => this.ownedByOther(ws, id));
        if (!ids) return CLOSE.badMessage;
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);
        return null;
      }
      return CLOSE.badMessage;
    } catch {
      return CLOSE.badMessage;
    }
  }

  private ownedByOther(ws: WebSocket, id: number): boolean {
    for (const [other, conn] of this.conns) if (other !== ws && conn.awarenessIds.has(id)) return true;
    return false;
  }

  private takeToken(conn: Connection): boolean {
    const now = Date.now();
    conn.tokens = Math.min(RATE.burst, conn.tokens + ((now - conn.lastRefill) / 1000) * RATE.perSecond);
    conn.lastRefill = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  /** Size check against an estimate, falling back to an exact measurement near the limit. */
  private hasRoomFor(bytes: number): boolean {
    if (this.approxBytes + bytes <= LIMITS.maxDocBytes) return true;
    this.approxBytes = Y.encodeStateAsUpdate(this.doc).length;
    return this.approxBytes + bytes <= LIMITS.maxDocBytes;
  }

  /**
   * Removes anything that isn't a valid element (wrong shape, out-of-range values, or
   * more elements than the board allows), so bad data from a modified client is never
   * stored or sent on to other users.
   */
  private sanitize(): void {
    const elements = this.elements;
    const bad: string[] = [];
    for (const [key, value] of elements) if (!validateElement(value, key)) bad.push(key);
    // Clients only read the "elements" map; anything else a client writes is inert and
    // still counts toward the document size limit.
    const overflow = elements.size - bad.length - LIMITS.maxElements;
    if (bad.length === 0 && overflow <= 0) return;

    this.doc.transact(() => {
      bad.forEach((key) => elements.delete(key));
      if (overflow > 0) {
        const newest = [...elements.entries()]
          .map(([key, value]) => ({ key, z: (value as { z: number }).z }))
          .sort((a, b) => b.z - a.z)
          .slice(0, overflow);
        newest.forEach(({ key }) => elements.delete(key));
      }
    }, SANITIZE);
  }

  private broadcast(message: Uint8Array): void {
    for (const ws of this.conns.keys()) send(ws, message);
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1000);
  }

  save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.destroyed) return;
    this.store.save(this.id, Y.encodeStateAsUpdate(this.doc));
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.saveTimer);
    this.awareness.destroy();
    this.doc.destroy();
  }
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

function syncMessage(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function send(ws: WebSocket, message: Uint8Array): void {
  if (ws.readyState === ws.OPEN) ws.send(message, (err) => err && ws.terminate());
}
