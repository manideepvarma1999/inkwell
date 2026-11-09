/**
 * Board elements and their validation. Board content comes from other users, so the
 * server and every client treat it as untrusted and validate it before use.
 */

export const LIMITS = {
  maxDocBytes: 2 * 1024 * 1024,
  maxElements: 5000,
  maxMessageBytes: 256 * 1024,
  maxPoints: 2000, // per stroke (x,y pairs)
  maxNoteText: 500,
  coordinate: 100_000,
  maxConnectionsPerBoard: 50,
} as const;

export const COLORS = ["#1f2937", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#2563eb", "#7c3aed", "#db2777"] as const;
export const NOTE_COLORS = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#fed7aa"] as const;

export interface Stroke {
  id: string;
  type: "stroke";
  color: string;
  width: number;
  points: number[]; // flat [x0, y0, x1, y1, ...]
  z: number;
}

export interface Note {
  id: string;
  type: "note";
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
  z: number;
}

export type Element = Stroke | Note;

const ID = /^[A-Za-z0-9_-]{8,32}$/;

const isCoord = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= LIMITS.coordinate;
const isZ = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Returns a clean copy of a valid element, or null. Extra properties are dropped. */
export function validateElement(value: unknown, key?: string): Element | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID.test(v.id) || (key !== undefined && key !== v.id)) return null;
  if (!isZ(v.z)) return null;

  if (v.type === "stroke") {
    if (!COLORS.includes(v.color as (typeof COLORS)[number])) return null;
    if (typeof v.width !== "number" || !Number.isInteger(v.width) || v.width < 1 || v.width > 40) return null;
    const points = v.points;
    if (!Array.isArray(points) || points.length < 2 || points.length % 2 !== 0 || points.length > LIMITS.maxPoints * 2) return null;
    if (!points.every(isCoord)) return null;
    return { id: v.id, type: "stroke", color: v.color as string, width: v.width, points: [...points], z: v.z };
  }

  if (v.type === "note") {
    if (!isCoord(v.x) || !isCoord(v.y)) return null;
    if (typeof v.w !== "number" || typeof v.h !== "number" || v.w < 80 || v.w > 600 || v.h < 60 || v.h > 600) return null;
    if (typeof v.text !== "string" || v.text.length > LIMITS.maxNoteText) return null;
    if (!NOTE_COLORS.includes(v.color as (typeof NOTE_COLORS)[number])) return null;
    return { id: v.id, type: "note", x: v.x, y: v.y, w: v.w, h: v.h, text: v.text, color: v.color as string, z: v.z };
  }
  return null;
}

export interface Presence {
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
}

/** Validates a user's presence (awareness) state; null means "left". */
export function validatePresence(value: unknown): Presence | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || v.name.length < 1 || v.name.length > 32) return undefined;
  if (typeof v.color !== "string" || !/^#[0-9a-f]{6}$/i.test(v.color)) return undefined;
  let cursor: Presence["cursor"] = null;
  if (v.cursor !== null && v.cursor !== undefined) {
    const c = v.cursor as Record<string, unknown>;
    if (!isCoord(c?.x) || !isCoord(c?.y)) return undefined;
    cursor = { x: c.x as number, y: c.y as number };
  }
  return { name: v.name, color: v.color, cursor };
}

/** Distance from point (px, py) to segment (ax, ay)-(bx, by); used for erasing. */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitsStroke(stroke: Stroke, x: number, y: number, radius: number): boolean {
  const p = stroke.points;
  if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= radius + stroke.width / 2;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (distanceToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= radius + stroke.width / 2) return true;
  }
  return false;
}
