import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "edit" | "view";

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const token = (bytes: number) => randomBytes(bytes).toString("base64url");

/**
 * Boards and their saved Yjs state, in SQLite. Each board has two capability keys
 * (edit and view). Only SHA-256 hashes of the keys are stored.
 */
export class BoardStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(dataDir === ":memory:" ? ":memory:" : path.join(dataDir, "inkwell.db"));
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists boards (
        id         text primary key,
        edit_hash  blob not null,
        view_hash  blob not null,
        state      blob,
        created_at integer not null,
        updated_at integer not null
      );
    `);
  }

  create(): { id: string; editKey: string; viewKey: string } {
    const id = token(16); // 128-bit, unguessable
    const editKey = token(32); // 256-bit
    const viewKey = token(32);
    const now = Date.now();
    this.db
      .prepare("insert into boards (id, edit_hash, view_hash, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .run(id, sha256(editKey), sha256(viewKey), now, now);
    return { id, editKey, viewKey };
  }

  /** Which role a key grants on a board, compared in constant time. */
  authorize(id: string, key: string): Role | null {
    const row = this.db.prepare("select edit_hash, view_hash from boards where id = ?").get(id) as
      | { edit_hash: Uint8Array; view_hash: Uint8Array }
      | undefined;
    const presented = sha256(key);
    // Compare against a dummy when the board doesn't exist so timing doesn't reveal which ids exist.
    const editHash = row ? Buffer.from(row.edit_hash) : sha256("missing-board");
    const viewHash = row ? Buffer.from(row.view_hash) : sha256("missing-board");
    const isEdit = timingSafeEqual(presented, editHash);
    const isView = timingSafeEqual(presented, viewHash);
    if (!row) return null;
    return isEdit ? "edit" : isView ? "view" : null;
  }

  load(id: string): Uint8Array | null {
    const row = this.db.prepare("select state from boards where id = ?").get(id) as { state: Uint8Array | null } | undefined;
    return row?.state ?? null;
  }

  save(id: string, state: Uint8Array): void {
    this.db.prepare("update boards set state = ?, updated_at = ? where id = ?").run(state, Date.now(), id);
  }

  close(): void {
    this.db.close();
  }
}
