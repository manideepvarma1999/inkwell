import { describe, expect, it } from "vitest";
import { hitsStroke, LIMITS, validateElement, validatePresence, type Stroke } from "../shared/schema";

const stroke: Stroke = { id: "abcdefgh12", type: "stroke", color: "#2563eb", width: 4, points: [0, 0, 100, 0], z: 1 };

describe("validateElement", () => {
  it("accepts valid elements and strips unknown properties", () => {
    expect(validateElement({ ...stroke, onclick: "alert(1)" })).toEqual(stroke);
    const note = { id: "note000001", type: "note", x: 5, y: 5, w: 200, h: 150, text: "hi", color: "#fef08a", z: 2 };
    expect(validateElement(note)).toEqual(note);
  });

  it("rejects bad shapes and values", () => {
    const bad = [
      null,
      "string",
      [],
      { ...stroke, id: "../../etc" },
      { ...stroke, color: "url(javascript:alert(1))" },
      { ...stroke, width: 0 },
      { ...stroke, width: 2.5 },
      { ...stroke, points: [1, 2, 3] },
      { ...stroke, points: [0, NaN] },
      { ...stroke, points: [0, LIMITS.coordinate + 1] },
      { ...stroke, points: new Array(LIMITS.maxPoints * 2 + 2).fill(0) },
      { ...stroke, z: -1 },
      { ...stroke, type: "image" },
      { id: "note000001", type: "note", x: 0, y: 0, w: 200, h: 150, text: "x".repeat(LIMITS.maxNoteText + 1), color: "#fef08a", z: 1 },
      { id: "note000001", type: "note", x: 0, y: 0, w: 5000, h: 150, text: "", color: "#fef08a", z: 1 },
    ];
    for (const value of bad) expect(validateElement(value), JSON.stringify(value)?.slice(0, 80)).toBeNull();
  });

  it("requires the map key to match the element id", () => {
    expect(validateElement(stroke, "abcdefgh12")).not.toBeNull();
    expect(validateElement(stroke, "otherkey00")).toBeNull();
  });
});

describe("validatePresence", () => {
  it("accepts names, colors and cursors within limits", () => {
    expect(validatePresence({ name: "Ada", color: "#aabbcc", cursor: { x: 1, y: 2 } })).toEqual({ name: "Ada", color: "#aabbcc", cursor: { x: 1, y: 2 } });
    expect(validatePresence(null)).toBeNull();
    expect(validatePresence({ name: "x".repeat(33), color: "#aabbcc" })).toBeUndefined();
    expect(validatePresence({ name: "Ada", color: "red" })).toBeUndefined();
    expect(validatePresence({ name: "Ada", color: "#aabbcc", cursor: { x: "1", y: 2 } })).toBeUndefined();
  });
});

describe("hitsStroke", () => {
  it("detects points near the line within the eraser radius", () => {
    expect(hitsStroke(stroke, 50, 3, 2)).toBe(true);
    expect(hitsStroke(stroke, 50, 20, 2)).toBe(false);
    expect(hitsStroke({ ...stroke, points: [10, 10] }, 11, 11, 2)).toBe(true);
  });
});
