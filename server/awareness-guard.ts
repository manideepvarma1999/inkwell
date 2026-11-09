import * as decoding from "lib0/decoding";
import { validatePresence } from "../shared/schema";

/**
 * Parses an awareness update and checks it before it's applied and rebroadcast:
 * a connection may only speak for client ids it already owns (or claims for the
 * first time), and every state must be a valid, small presence object.
 * Returns the client ids in the update, or null to reject it.
 */
export function checkAwarenessUpdate(
  update: Uint8Array,
  ownIds: Set<number>,
  idsOwnedByOthers: (id: number) => boolean,
): number[] | null {
  if (update.length > 4096) return null;
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    if (count > 4) return null;
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder); // clock
      const json = decoding.readVarString(decoder);
      if (!ownIds.has(clientId) && idsOwnedByOthers(clientId)) return null; // impersonation
      const state = JSON.parse(json);
      if (validatePresence(state) === undefined) return null;
      ids.push(clientId);
    }
    if (decoding.hasContent(decoder)) return null;
    return ids;
  } catch {
    return null;
  }
}
