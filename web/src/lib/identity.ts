const ANIMALS = ["Otter", "Heron", "Lynx", "Badger", "Falcon", "Koala", "Panda", "Fox", "Wren", "Ibis"];
const CURSOR_COLORS = ["#e11d48", "#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777"];

export interface Identity {
  name: string;
  color: string;
}

// A per-browser convenience only; nothing here is trusted by the server.
export function loadIdentity(): Identity {
  try {
    const saved = JSON.parse(localStorage.getItem("inkwell.identity") ?? "null");
    if (saved && typeof saved.name === "string" && /^#[0-9a-f]{6}$/i.test(saved.color)) {
      return { name: saved.name.slice(0, 32) || "Guest", color: saved.color };
    }
  } catch {
    /* storage unavailable */
  }
  const identity = {
    name: `${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]} ${Math.floor(Math.random() * 90 + 10)}`,
    color: CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)],
  };
  saveIdentity(identity);
  return identity;
}

export function saveIdentity(identity: Identity) {
  try {
    localStorage.setItem("inkwell.identity", JSON.stringify(identity));
  } catch {
    /* storage unavailable */
  }
}

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Board links carry keys in the fragment (#k=...), which browsers never send to servers. */
export function parseFragment(): { key: string | null; viewKey: string | null } {
  const params = new URLSearchParams(location.hash.slice(1));
  return { key: params.get("k"), viewKey: params.get("v") };
}
