import { useCallback, useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as Y from "yjs";
import { COLORS, hitsStroke, LIMITS, NOTE_COLORS, validateElement, validatePresence, type Element, type Note, type Stroke } from "../../shared/schema";
import { BoardConnection } from "./lib/connection";
import { loadIdentity, randomId, saveIdentity, type Identity } from "./lib/identity";

type Tool = "pen" | "eraser" | "note" | "hand";
interface Camera {
  x: number;
  y: number;
  zoom: number;
}

const clampCoord = (n: number) => Math.max(-LIMITS.coordinate, Math.min(LIMITS.coordinate, Math.round(n * 10) / 10));

export function Board({ boardId, boardKey, viewKey }: { boardId: string; boardKey: string; viewKey: string | null }) {
  const [conn, setConn] = useState<BoardConnection | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [identity, setIdentity] = useState<Identity>(loadIdentity);
  const [shareOpen, setShareOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const undo = useRef<Y.UndoManager | null>(null);

  // One connection per mounted board.
  useEffect(() => {
    const c = new BoardConnection(boardId, boardKey);
    const elements = c.doc.getMap("elements");
    undo.current = new Y.UndoManager(elements, { captureTimeout: 400 });
    const offStatus = c.subscribe(rerender);
    elements.observe(rerender);
    c.awareness.on("change", rerender);
    setConn(c);
    return () => {
      offStatus();
      undo.current?.destroy();
      c.destroy();
    };
  }, [boardId, boardKey]);

  const canEdit = conn?.role === "edit";
  const elements = conn?.doc.getMap("elements");

  // Read board content defensively: anything invalid from another client is skipped.
  const items: Element[] = [];
  elements?.forEach((value, key) => {
    const el = validateElement(value, key);
    if (el) items.push(el);
  });
  items.sort((a, b) => a.z - b.z);
  const strokes = items.filter((e): e is Stroke => e.type === "stroke");
  const notes = items.filter((e): e is Note => e.type === "note");

  // ---- rendering ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = canvas;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d")!;
    const cam = camera.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Dot grid
    const spacing = 32 * cam.zoom;
    if (spacing > 8) {
      ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--grid") || "#d4d4d8";
      for (let x = ((cam.x % spacing) + spacing) % spacing; x < w; x += spacing)
        for (let y = ((cam.y % spacing) + spacing) % spacing; y < h; y += spacing) ctx.fillRect(x, y, 1.5, 1.5);
    }

    ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * cam.x, dpr * cam.y);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width;
      if (s.points.length === 2) {
        ctx.beginPath();
        ctx.arc(s.points[0], s.points[1], s.width / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s.points[0], s.points[1]);
      for (let i = 2; i < s.points.length; i += 2) ctx.lineTo(s.points[i], s.points[i + 1]);
      ctx.stroke();
    }
  }, [strokes]);

  useEffect(() => {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  });
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  // ---- input ----
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cam = camera.current;
    return { x: (clientX - rect.left - cam.x) / cam.zoom, y: (clientY - rect.top - cam.y) / cam.zoom };
  };

  const gesture = useRef<
    | { kind: "draw"; id: string; points: number[]; lastSync: number }
    | { kind: "pan"; startX: number; startY: number; camX: number; camY: number }
    | { kind: "erase" }
    | null
  >(null);
  const spaceDown = useRef(false);
  const lastCursorSent = useRef(0);

  const erase = (x: number, y: number) => {
    if (!elements) return;
    const radius = 8 / camera.current.zoom;
    const hit = strokes.filter((s) => hitsStroke(s, x, y, radius));
    if (hit.length) conn!.doc.transact(() => hit.forEach((s) => elements.delete(s.id)));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!elements) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = toWorld(e.clientX, e.clientY);
    const panning = tool === "hand" || spaceDown.current || e.button === 1 || !canEdit;
    if (panning) {
      gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, camX: camera.current.x, camY: camera.current.y };
      return;
    }
    if (e.button !== 0) return;
    undo.current?.stopCapturing();
    if (tool === "pen") {
      const id = randomId();
      const points = [clampCoord(x), clampCoord(y)];
      gesture.current = { kind: "draw", id, points, lastSync: performance.now() };
      elements.set(id, { id, type: "stroke", color, width, points, z: Date.now() } satisfies Stroke);
    } else if (tool === "eraser") {
      gesture.current = { kind: "erase" };
      erase(x, y);
    } else if (tool === "note") {
      const id = randomId();
      elements.set(id, { id, type: "note", x: clampCoord(x - 100), y: clampCoord(y - 60), w: 200, h: 150, text: "", color: NOTE_COLORS[0], z: Date.now() } satisfies Note);
      setTool("pen");
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toWorld(e.clientX, e.clientY);
    const now = performance.now();
    if (conn && now - lastCursorSent.current > 50) {
      lastCursorSent.current = now;
      conn.awareness.setLocalStateField("cursor", { x: clampCoord(x), y: clampCoord(y) });
    }
    const g = gesture.current;
    if (!g || !elements) return;
    if (g.kind === "pan") {
      camera.current.x = g.camX + (e.clientX - g.startX);
      camera.current.y = g.camY + (e.clientY - g.startY);
      rerender();
    } else if (g.kind === "erase") {
      erase(x, y);
    } else if (g.kind === "draw") {
      const n = g.points.length;
      const minStep = 1.5 / camera.current.zoom;
      if (Math.hypot(x - g.points[n - 2], y - g.points[n - 1]) < minStep || n >= LIMITS.maxPoints * 2) return;
      g.points.push(clampCoord(x), clampCoord(y));
      if (now - g.lastSync > 40) {
        g.lastSync = now;
        syncStroke(g.id, g.points);
      }
    }
  };

  const syncStroke = (id: string, points: number[]) => {
    const current = validateElement(elements?.get(id), id);
    if (current?.type === "stroke") elements!.set(id, { ...current, points: [...points] });
  };

  const onPointerUp = () => {
    const g = gesture.current;
    if (g?.kind === "draw") syncStroke(g.id, g.points);
    gesture.current = null;
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const cam = camera.current;
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const zoom = Math.min(4, Math.max(0.2, cam.zoom * Math.exp(-e.deltaY * 0.0015)));
    cam.x = mx - ((mx - cam.x) * zoom) / cam.zoom;
    cam.y = my - ((my - cam.y) * zoom) / cam.zoom;
    cam.zoom = zoom;
    rerender();
  };

  // Presence and keyboard shortcuts
  useEffect(() => {
    conn?.awareness.setLocalStateField("name", identity.name);
    conn?.awareness.setLocalStateField("color", identity.color);
  }, [conn, identity]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea")) return;
      if (e.key === " ") spaceDown.current = e.type === "keydown";
      if (e.type !== "keydown") return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) undo.current?.redo();
        else undo.current?.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        undo.current?.redo();
      } else if (!mod) {
        const map: Record<string, Tool> = { p: "pen", e: "eraser", n: "note", h: "hand" };
        if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  if (!conn) return null;
  if (conn.status === "unauthorized") {
    return <FullMessage title="This link doesn't work" body="The board doesn't exist or the key in the link is wrong. Ask for a new link." />;
  }
  if (conn.status === "full") {
    return <FullMessage title="This board is full" body="It has too many people connected or has reached its size limit." />;
  }

  const cam = camera.current;
  const others: { id: number; name: string; color: string; cursor: { x: number; y: number } }[] = [];
  conn.awareness.getStates().forEach((state, id) => {
    if (id === conn.doc.clientID) return;
    const p = validatePresence(state);
    if (p && p.cursor) others.push({ id, name: p.name, color: p.color, cursor: p.cursor });
  });

  const editLink = `${location.origin}/b/${boardId}#k=${canEdit ? boardKey : ""}`;
  const viewLink = viewKey ? `${location.origin}/b/${boardId}#k=${viewKey}` : null;

  return (
    <div className="board">
      <canvas
        ref={canvasRef}
        className={`board-canvas tool-${!canEdit ? "hand" : tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => conn.awareness.setLocalStateField("cursor", null)}
        onWheel={onWheel}
        aria-label="Whiteboard canvas"
      />

      {notes.map((note) => (
        <StickyNote key={note.id} note={note} camera={cam} canEdit={canEdit} elements={elements!} />
      ))}

      {others.map((o) => (
        <div key={o.id} className="cursor" style={{ transform: `translate(${o.cursor.x * cam.zoom + cam.x}px, ${o.cursor.y * cam.zoom + cam.y}px)` }}>
          <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true">
            <path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" fill={o.color} stroke="white" strokeWidth="1.2" />
          </svg>
          <span style={{ background: o.color }}>{o.name}</span>
        </div>
      ))}

      <header className="topbar">
        <a href="/" className="brand">Inkwell</a>
        <span className={`status status-${conn.status}`}>{conn.status === "online" ? "Live" : conn.status === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
        {!canEdit && conn.role && <span className="badge">View only</span>}
        <span className="people" title="People here">{others.length + 1} here</span>
        <button type="button" onClick={() => setShareOpen((v) => !v)} aria-expanded={shareOpen}>Share</button>
      </header>

      {shareOpen && (
        <div className="share" role="dialog" aria-label="Share this board">
          <label>
            Your name
            <input
              value={identity.name}
              maxLength={32}
              onChange={(e) => {
                const next = { ...identity, name: e.target.value.slice(0, 32) || "Guest" };
                setIdentity(next);
                saveIdentity(next);
              }}
            />
          </label>
          {canEdit && <CopyField label="Edit link (anyone with it can edit)" value={editLink} />}
          {viewLink && <CopyField label="View-only link" value={viewLink} />}
          <p className="hint">Links are the only way in, and the key after # is never sent to the server. Treat edit links like passwords.</p>
        </div>
      )}

      {canEdit && (
        <nav className="toolbar" aria-label="Tools">
          {(
            [
              ["pen", "Pen (P)", "✎"],
              ["eraser", "Eraser (E)", "⌫"],
              ["note", "Sticky note (N)", "▢"],
              ["hand", "Pan (H or hold Space)", "✋"],
            ] as const
          ).map(([value, label, icon]) => (
            <button key={value} type="button" aria-label={label} title={label} aria-pressed={tool === value} onClick={() => setTool(value)}>
              {icon}
            </button>
          ))}
          <span className="divider" />
          {COLORS.map((c) => (
            <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={color === c} onClick={() => { setColor(c); setTool("pen"); }} />
          ))}
          <span className="divider" />
          <label className="width">
            <span className="sr-only">Stroke width</span>
            <input type="range" min={1} max={24} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
          <button type="button" aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" onClick={() => undo.current?.undo()}>↶</button>
          <button type="button" aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)" onClick={() => undo.current?.redo()}>↷</button>
        </nav>
      )}
    </div>
  );
}

function StickyNote({ note, camera, canEdit, elements }: { note: Note; camera: Camera; canEdit: boolean; elements: Y.Map<unknown> }) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const update = (patch: Partial<Note>) => {
    const current = validateElement(elements.get(note.id), note.id);
    if (current?.type === "note") elements.set(note.id, { ...current, ...patch });
  };

  return (
    <div
      className="note"
      style={{
        background: note.color,
        transform: `translate(${note.x * camera.zoom + camera.x}px, ${note.y * camera.zoom + camera.y}px) scale(${camera.zoom})`,
        width: note.w,
        height: note.h,
      }}
    >
      <div
        className="note-bar"
        onPointerDown={(e) => {
          if (!canEdit) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { dx: e.clientX / camera.zoom - note.x, dy: e.clientY / camera.zoom - note.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          update({ x: clampCoord(e.clientX / camera.zoom - drag.current.dx), y: clampCoord(e.clientY / camera.zoom - drag.current.dy) });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        {canEdit && (
          <>
            {NOTE_COLORS.map((c) => (
              <button key={c} type="button" className="note-color" style={{ background: c }} aria-label={`Note color ${c}`} onClick={() => update({ color: c })} />
            ))}
            <button type="button" className="note-delete" aria-label="Delete note" onClick={() => elements.delete(note.id)}>×</button>
          </>
        )}
      </div>
      <textarea
        aria-label="Note text"
        value={note.text}
        readOnly={!canEdit}
        maxLength={LIMITS.maxNoteText}
        placeholder={canEdit ? "Type here…" : ""}
        onChange={(e) => update({ text: e.target.value.slice(0, LIMITS.maxNoteText) })}
      />
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <label>
      {label}
      <span className="copy">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </label>
  );
}

function FullMessage({ title, body }: { title: string; body: string }) {
  return (
    <main className="center">
      <h1>{title}</h1>
      <p>{body}</p>
      <a href="/">Create a new board</a>
    </main>
  );
}
