import { useState } from "react";
import { BOARD_ID, BOARD_KEY } from "../../shared/protocol";
import { Board } from "./Board";
import { parseFragment } from "./lib/identity";

export function App() {
  const match = location.pathname.match(/^\/b\/([^/]+)\/?$/);
  if (!match) return <Home />;
  const { key, viewKey } = parseFragment();
  if (!BOARD_ID.test(match[1]) || !key || !BOARD_KEY.test(key)) {
    return (
      <main className="center">
        <h1>This link is incomplete</h1>
        <p>Board links include a key after the # sign. Ask whoever shared it to copy the whole link.</p>
        <a href="/">Create a new board</a>
      </main>
    );
  }
  return <Board boardId={match[1]} boardKey={key} viewKey={viewKey && BOARD_KEY.test(viewKey) ? viewKey : null} />;
}

function Home() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/boards", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      location.assign(`/b/${body.id}#k=${body.editKey}&v=${body.viewKey}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <h1>
        Ink<span>well</span>
      </h1>
      <p className="lead">A whiteboard for thinking together. Draw, drop sticky notes, and see everyone&apos;s cursor live. No account needed.</p>
      <button type="button" className="primary" onClick={create} disabled={busy}>
        {busy ? "Creating…" : "Create a board"}
      </button>
      {error && <p role="alert" className="error">{error}</p>}
      <ul className="features">
        <li><strong>Conflict-free.</strong> Edits merge automatically using CRDTs, even after you reconnect.</li>
        <li><strong>Private links.</strong> Separate edit and view-only links. Keys stay in the link and never reach server logs.</li>
        <li><strong>Live presence.</strong> See who&apos;s here and where they&apos;re pointing.</li>
      </ul>
    </main>
  );
}
