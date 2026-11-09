/**
 * Wire protocol. After the WebSocket opens, the client sends one JSON text frame to
 * authenticate; everything after that is binary y-websocket messages:
 *   [0, ...] Yjs sync (step 1, step 2, update)
 *   [1, ...] awareness (presence)
 * The board key travels in this first message, never in the URL, so it doesn't end up
 * in proxy or server access logs.
 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

export interface AuthMessage {
  type: "auth";
  board: string;
  key: string;
}

export interface AuthResult {
  type: "ready";
  role: "edit" | "view";
}

/** Close codes (4000-4999 are application-defined). */
export const CLOSE = {
  unauthorized: 4401,
  authTimeout: 4408,
  boardFull: 4413,
  rateLimited: 4429,
  badMessage: 4400,
  tooManyConnections: 4503,
} as const;

export const BOARD_ID = /^[A-Za-z0-9_-]{22}$/;
export const BOARD_KEY = /^[A-Za-z0-9_-]{43}$/;
