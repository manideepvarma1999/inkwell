import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { CLOSE, MESSAGE_AWARENESS, MESSAGE_SYNC, type AuthResult } from "../../../shared/protocol";

export type Status = "connecting" | "online" | "offline" | "unauthorized" | "full";

/**
 * Keeps a Y.Doc and presence in sync with the server over one WebSocket, reconnecting
 * with backoff. The board key is sent in the first message, not in the URL.
 */
export class BoardConnection {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  role: AuthResult["role"] | null = null;
  status: Status = "connecting";
  private ws: WebSocket | null = null;
  private retries = 0;
  private stopped = false;
  private listeners = new Set<() => void>();
  private retryTimer: number | undefined;

  constructor(
    private board: string,
    private key: string,
  ) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this || this.role !== "edit") return;
      this.send(message(MESSAGE_SYNC, (e) => syncProtocol.writeUpdate(e, update)));
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this) return;
      const changed = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
      if (changed.length) this.send(message(MESSAGE_AWARENESS, (e) => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))));
    });
    window.addEventListener("beforeunload", this.leave);
    this.connect();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: Status) {
    this.status = status;
    this.listeners.forEach((l) => l());
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.setStatus("connecting");

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", board: this.board, key: this.key }));
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data) as AuthResult;
        if (msg.type !== "ready") return;
        this.role = msg.role;
        this.retries = 0;
        this.send(message(MESSAGE_SYNC, (e) => syncProtocol.writeSyncStep1(e, this.doc)));
        if (this.awareness.getLocalState()) {
          this.send(message(MESSAGE_AWARENESS, (e) => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))));
        }
        this.setStatus("online");
        return;
      }
      this.receive(new Uint8Array(event.data as ArrayBuffer));
    };
    ws.onclose = (event) => {
      this.ws = null;
      // Forget other people's cursors; they'll be resent on reconnect.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      if (this.stopped) return;
      if (event.code === CLOSE.unauthorized) return this.setStatus("unauthorized");
      if (event.code === CLOSE.tooManyConnections || event.code === CLOSE.boardFull) return this.setStatus("full");
      this.setStatus("offline");
      const delay = Math.min(30_000, 500 * 2 ** this.retries++) * (0.5 + Math.random() / 2);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private receive(data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
      if (encoding.length(reply) > 1) this.send(encoding.toUint8Array(reply));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  private send(data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data as Uint8Array<ArrayBuffer>);
  }

  private leave = () => {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "leave");
  };

  destroy() {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.removeEventListener("beforeunload", this.leave);
    this.leave();
    this.ws?.close();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

function message(type: number, write: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
}
