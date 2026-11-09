import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLOSE } from "../shared/protocol";
import { LIMITS } from "../shared/schema";
import { Client, connect, createBoard, eventually, start, stroke, type Running } from "./helpers";

let running: Running[] = [];
afterEach(async () => {
  await Promise.all(running.map((r) => r.stop()));
  running = [];
});
async function server(...args: Parameters<typeof start>) {
  const r = await start(...args);
  running.push(r);
  return r;
}

describe("authentication", () => {
  it("rejects wrong keys, unknown boards and malformed auth", async () => {
    const r = await server();
    const board = await createBoard(r);
    const attempts = [
      { board: board.id, key: "A".repeat(43) },
      { board: "B".repeat(22), key: board.editKey },
      { board: board.id, key: "short" },
    ];
    for (const auth of attempts) {
      const c = new Client(r.wsUrl, r.origin, auth);
      await c.opened;
      expect(c.role).toBeNull();
      expect(await c.waitClosed()).toBe(CLOSE.unauthorized);
    }
  });

  it("closes connections that never authenticate", async () => {
    const r = await server();
    const c = new Client(r.wsUrl, r.origin, null);
    expect(await c.waitClosed()).toBe(CLOSE.authTimeout);
  }, 10_000);

  it("refuses WebSocket upgrades from other origins and without an Origin", async () => {
    const r = await server();
    const board = await createBoard(r);
    await expect(new Client(r.wsUrl, "https://evil.example", { board: board.id, key: board.editKey }).opened).rejects.toThrow("HTTP 403");
    await expect(new Client(r.wsUrl, undefined, { board: board.id, key: board.editKey }).opened).rejects.toThrow("HTTP 403");
  });

  it("stores only hashes of board keys", async () => {
    const r = await server();
    const board = await createBoard(r);
    const db = new DatabaseSync(path.join(r.dataDir, "inkwell.db"), { readOnly: true });
    const row = db.prepare("select edit_hash, view_hash from boards where id = ?").get(board.id) as Record<string, Uint8Array>;
    db.close();
    for (const hash of Object.values(row)) {
      expect(Buffer.from(hash).toString()).not.toContain(board.editKey);
      expect(Buffer.from(hash).length).toBe(32);
    }
  });
});

describe("collaboration", () => {
  it("syncs edits between editors and to viewers", async () => {
    const r = await server();
    const board = await createBoard(r);
    const alice = await connect(r, board.id, board.editKey);
    const bob = await connect(r, board.id, board.editKey);
    const viewer = await connect(r, board.id, board.viewKey);
    expect([alice.role, bob.role, viewer.role]).toEqual(["edit", "edit", "view"]);

    alice.elements.set("stroke0001", stroke("stroke0001"));
    await eventually(() => bob.elements.has("stroke0001") && viewer.elements.has("stroke0001"));
  });

  it("ignores changes sent by view-only connections", async () => {
    const r = await server();
    const board = await createBoard(r);
    const editor = await connect(r, board.id, board.editKey);
    const viewer = await connect(r, board.id, board.viewKey);

    viewer.elements.set("viewer0001", stroke("viewer0001"));
    editor.elements.set("editor0001", stroke("editor0001"));
    await eventually(() => viewer.elements.has("editor0001"));
    await new Promise((res) => setTimeout(res, 200));
    expect(r.app.rooms.get(board.id)!.elements.has("viewer0001")).toBe(false);
    expect(editor.elements.has("viewer0001")).toBe(false);
  });

  it("removes invalid elements before they are stored or relayed", async () => {
    const r = await server();
    const board = await createBoard(r);
    const attacker = await connect(r, board.id, board.editKey);
    const other = await connect(r, board.id, board.editKey);

    attacker.elements.set("evil000001", { id: "evil000001", type: "note", x: 0, y: 0, w: 100, h: 100, text: "x".repeat(10_000), color: "#fef08a", z: 1 });
    attacker.elements.set("evil000002", { id: "evil000002", type: "script", src: "javascript:alert(1)", z: 1 });
    attacker.elements.set("mismatch01", stroke("different1"));
    attacker.elements.set("good000001", stroke("good000001"));

    await eventually(() => other.elements.has("good000001"));
    await eventually(() => !attacker.elements.has("evil000001") && !attacker.elements.has("evil000002") && !attacker.elements.has("mismatch01"));
    expect([...r.app.rooms.get(board.id)!.elements.keys()]).toEqual(["good000001"]);
  });

  it("persists boards across restarts", async () => {
    const first = await start();
    const board = await createBoard(first);
    const c = await connect(first, board.id, board.editKey);
    c.elements.set("persist001", stroke("persist001"));
    await eventually(() => first.app.rooms.get(board.id)!.elements.has("persist001"));
    c.close();
    await first.stop(true);

    const second = await server(first.dataDir);
    const again = await connect(second, board.id, board.viewKey);
    await eventually(() => again.elements.has("persist001"));
  });
});

describe("abuse limits", () => {
  it("closes connections that flood messages", async () => {
    const r = await server();
    const board = await createBoard(r);
    const c = await connect(r, board.id, board.editKey);
    for (let i = 0; i < 500; i++) c.sendRaw(new Uint8Array([0, 0, 1, 0]));
    expect(await c.waitClosed()).toBe(CLOSE.rateLimited);
  });

  it("rejects oversized frames", async () => {
    const r = await server();
    const board = await createBoard(r);
    const c = await connect(r, board.id, board.editKey);
    c.sendRaw(new Uint8Array(LIMITS.maxMessageBytes + 1024));
    expect([1006, 1009]).toContain(await c.waitClosed()); // ws closes with 1009 "message too big"
  });

  it("rejects garbage and text frames after auth", async () => {
    const r = await server();
    const board = await createBoard(r);
    const a = await connect(r, board.id, board.editKey);
    a.sendRaw(new Uint8Array([7, 7, 7]));
    expect(await a.waitClosed()).toBe(CLOSE.badMessage);
    const b = await connect(r, board.id, board.editKey);
    b.sendRaw("hello");
    expect(await b.waitClosed()).toBe(CLOSE.badMessage);
  });

  it("drops presence that impersonates another user or is malformed", async () => {
    const r = await server();
    const board = await createBoard(r);
    const alice = await connect(r, board.id, board.editKey);
    const mallory = await connect(r, board.id, board.editKey);
    alice.sendAwareness({ name: "Alice", color: "#2563eb", cursor: { x: 1, y: 2 } });
    await eventually(() => mallory.awareness.getStates().has(alice.doc.clientID));

    mallory.sendAwareness({ name: "Alice", color: "#dc2626", cursor: null }, alice.doc.clientID);
    expect(await mallory.waitClosed()).toBe(CLOSE.badMessage);

    const eve = await connect(r, board.id, board.editKey);
    eve.sendAwareness({ name: "<img src=x onerror=alert(1)>".repeat(5), color: "red" });
    expect(await eve.waitClosed()).toBe(CLOSE.badMessage);
  });

  it("limits board creation per IP and requires a same-site Origin", async () => {
    const r = await server(undefined, { boardsPerHourPerIp: 2 });
    await createBoard(r);
    await createBoard(r);
    const third = await fetch(`${r.origin}/api/boards`, { method: "POST", headers: { Origin: r.origin } });
    expect(third.status).toBe(429);
    const crossSite = await fetch(`${r.origin}/api/boards`, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
  });

  it("caps concurrent connections per IP", async () => {
    const r = await server(undefined, { connectionsPerIp: 2 });
    const board = await createBoard(r);
    await connect(r, board.id, board.editKey);
    await connect(r, board.id, board.editKey);
    await expect(new Client(r.wsUrl, r.origin, { board: board.id, key: board.editKey }).opened).rejects.toThrow("HTTP 429");
  });

  it("sends security headers", async () => {
    const r = await server();
    const res = await fetch(`${r.origin}/api/health`);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

