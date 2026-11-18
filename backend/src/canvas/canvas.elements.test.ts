import { describe, expect, it } from "vitest";
import { cleanElements, cleanViewport, MAX_ELEMENTS } from "./canvas.elements";

describe("canvas elements", () => {
  it("keeps known kinds and their fields", () => {
    const out = cleanElements([
      { id: "a", k: "sticky", x: 10.123, y: 20, w: 200, h: 200, text: "Idea", fill: "#fde68a", z: 1 },
      { id: "b", k: "shape", shape: "ellipse", x: 0, y: 0, w: 50, h: 50, fill: "#fff", stroke: "#000", sw: 3 },
      { id: "c", k: "path", x: 0, y: 0, w: 10, h: 10, pts: [0, 0, 5, 5, 10, 10], stroke: "#111" },
      { id: "d", k: "connector", a: { id: "a", x: 0, y: 0 }, b: { id: "b", x: 0, y: 0 } },
      { id: "e", k: "image", src: "https://api.example.com/media/1.png", x: 0, y: 0, w: 100, h: 80 },
    ]);
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(out[0]).toMatchObject({ k: "sticky", x: 10.12, text: "Idea", fill: "#fde68a" });
    expect(out[1]).toMatchObject({ shape: "ellipse", sw: 3 });
  });

  it("drops unknown kinds, bad ids, duplicates and inline images", () => {
    const out = cleanElements([
      { id: "a", k: "nope" },
      { id: "bad id!", k: "text" },
      { id: "x", k: "text", text: "1" },
      { id: "x", k: "text", text: "2" },
      { id: "i", k: "image", src: "data:image/png;base64,AAAA" },
      { id: "p", k: "path", pts: [1] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("1");
  });

  it("refuses unsafe colors and bounds numbers", () => {
    const [e] = cleanElements([{ id: "t", k: "text", x: Infinity, y: "12", fill: "red;background:url(x)", size: 9999 }]);
    expect(e.fill).toBeUndefined();
    expect(e.x).toBe(0);
    expect(e.y).toBe(12);
    expect(e.size).toBe(400);
  });

  it("caps the number of elements", () => {
    const many = Array.from({ length: MAX_ELEMENTS + 10 }, (_, i) => ({ id: "n" + i, k: "text", text: "" }));
    expect(cleanElements(many)).toHaveLength(MAX_ELEMENTS);
  });

  it("bounds the zoom", () => {
    expect(cleanViewport({ x: 5, y: 6, z: 100 })).toEqual({ x: 5, y: 6, z: 8 });
    expect(cleanViewport(null)).toEqual({ x: 0, y: 0, z: 1 });
  });
});
