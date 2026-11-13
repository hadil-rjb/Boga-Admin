import { describe, expect, it } from "vitest";
import { convertFrame } from "./convert";

/** Figma REST helpers: a node at (x, y), size w×h, turned by `deg` relative to its parent (Figma's sign: counterclockwise) */
const at = (x: number, y: number, w: number, h: number, deg = 0) => {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), q = Math.abs(deg % 180) === 90;
  return { absoluteBoundingBox: { x, y, width: q ? h : w, height: q ? w : h }, size: { x: w, y: h }, relativeTransform: [[c, s, x], [-s, c, y]] };
};
const solid = (r: number, g: number, b: number, a = 1) => ({ type: "SOLID", color: { r, g, b, a } });
const text = (id: string, chars: string, box: any, extra: any = {}) => ({ id, type: "TEXT", name: chars, characters: chars, ...box, fills: [solid(1, 1, 1)], style: { fontFamily: "Inter", fontSize: 20, fontWeight: 400, lineHeightPx: 24 }, ...extra });
const convert = (frame: any) => { let i = 0; return convertFrame(frame, () => "L" + ++i, (f) => f); };
const byName = (out: ReturnType<typeof convert>, name: string) => out.layers.find((l) => l.name === name)!;

describe("Figma import: layer tree", () => {
  it("keeps frames and groups as containers, with auto layout and constraints", () => {
    const out = convert({
      id: "0:1", type: "FRAME", name: "Post", ...at(0, 0, 1080, 1350), fills: [solid(1, 1, 1)], children: [
        { id: "1:1", type: "GROUP", name: "Logo row", ...at(40, 40, 300, 60), children: [text("2:1", "Brand", at(40, 40, 200, 60)), { id: "2:2", type: "ELLIPSE", name: "Dot", ...at(280, 40, 60, 60), fills: [solid(1, 0, 0)] }] },
        {
          id: "1:2", type: "FRAME", name: "Card", ...at(100, 300, 880, 400), fills: [solid(0, 0, 0, 0.5)], cornerRadius: 24, layoutMode: "VERTICAL", itemSpacing: 16,
          paddingTop: 20, paddingRight: 30, paddingBottom: 20, paddingLeft: 30, primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "MAX", primaryAxisSizingMode: "FIXED",
          constraints: { horizontal: "LEFT_RIGHT", vertical: "BOTTOM" },
          children: [text("3:1", "Title", at(130, 320, 820, 40), { layoutAlign: "STRETCH" }), text("3:2", "Body", at(130, 376, 400, 120), { layoutGrow: 1 })],
        },
      ],
    });
    const g = byName(out, "Logo row"), card = byName(out, "Card");
    expect(g.type).toBe("group");
    expect(byName(out, "Brand").pid).toBe(g.id);
    expect(byName(out, "Dot").pid).toBe(g.id);
    expect(card).toMatchObject({ type: "frame", r: 24, al: { d: "v", g: 16, p: [20, 30, 20, 30], m: "center", c: "end" } });
    expect(card.ct).toBeUndefined(); // the page is not a frame: nothing to follow
    expect(byName(out, "Title")).toMatchObject({ pid: card.id, stc: true });
    expect(byName(out, "Body")).toMatchObject({ pid: card.id, gr: true });
    expect(byName(out, "Brand").ah).toBeUndefined(); // a fixed text box stays fixed
    expect(out.rasters).toEqual([]);
  });

  it("keeps a mask as a layer that masks the layers above it, even turned and with a gradient", () => {
    const out = convert({
      id: "0:1", type: "FRAME", name: "Post", ...at(0, 0, 1000, 1000), fills: [solid(1, 1, 1)], children: [
        { id: "1:1", type: "GROUP", name: "Mask group", ...at(100, 100, 400, 400, 45), children: [
          { id: "2:1", type: "RECTANGLE", name: "Fade", isMask: true, ...at(0, 0, 400, 400), fills: [{ type: "GRADIENT_RADIAL", gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 0 } }] }] },
          { id: "2:2", type: "RECTANGLE", name: "Photo", ...at(-50, -50, 500, 500), fills: [{ type: "IMAGE", imageRef: "img", scaleMode: "FILL" }], blendMode: "COLOR_DODGE" },
        ] },
        { id: "1:2", type: "GROUP", name: "Circle group", ...at(600, 600, 200, 200), children: [
          { id: "3:1", type: "ELLIPSE", name: "Circle", isMask: true, maskType: "VECTOR", ...at(0, 0, 200, 200), fills: [] },
          { id: "3:2", type: "RECTANGLE", name: "Face", ...at(0, 0, 200, 200), fills: [{ type: "IMAGE", imageRef: "face" }] },
        ] },
      ],
    });
    const g = byName(out, "Mask group"), fade = byName(out, "Fade");
    expect(fade).toMatchObject({ type: "rect", mask: true, pid: g.id, rot: -45 });
    expect(fade.fill).toMatch(/^radial-gradient/);
    expect(byName(out, "Photo")).toMatchObject({ type: "image", pid: g.id, blend: "color-dodge" });
    expect(out.layers.indexOf(fade)).toBeLessThan(out.layers.indexOf(byName(out, "Photo"))); // the mask sits under what it masks
    expect(byName(out, "Circle")).toMatchObject({ type: "ellipse", mask: true, mt: "vec", fill: "#FFFFFF" });
    expect(out.rasters).toEqual([]);
  });

  it("keeps a blended group's layers, each with its blend mode", () => {
    const out = convert({
      id: "0:1", type: "FRAME", name: "Post", ...at(0, 0, 1000, 1000), fills: [], children: [
        { id: "1:1", type: "GROUP", name: "Glow", blendMode: "OVERLAY", opacity: 0.5, ...at(0, 0, 500, 500), children: [
          { id: "2:1", type: "ELLIPSE", name: "A", ...at(0, 0, 300, 300), fills: [solid(1, 1, 1)] },
          { id: "2:2", type: "ELLIPSE", name: "B", ...at(200, 200, 300, 300), fills: [solid(1, 1, 1)] },
        ] },
      ],
    });
    expect(byName(out, "Glow")).toMatchObject({ type: "group", op: 0.5 });
    expect(byName(out, "A").blend).toBe("overlay");
    expect(byName(out, "B").blend).toBe("overlay");
    expect(out.rasters).toEqual([]);
  });
});

describe("Figma import: transforms", () => {
  it("imports a turned frame as it shows, and group children relative to their group", () => {
    // a 1920×1080 frame turned a quarter (shown 1080×1920); its content turned back, so it stands upright on screen
    const out = convert({
      id: "0:1", type: "FRAME", name: "Reel", ...at(0, 0, 1920, 1080, 90), absoluteBoundingBox: { x: 0, y: 0, width: 1080, height: 1920 }, fills: [solid(0, 0, 0)], children: [
        text("1:1", "Headline", { ...at(100, 800, 800, 100, -90), absoluteBoundingBox: { x: 100, y: 800, width: 800, height: 100 } }),
        { id: "1:2", type: "GROUP", name: "Logo", ...at(400, 100, 200, 50, -90), absoluteBoundingBox: { x: 400, y: 100, width: 200, height: 50 }, children: [
          { id: "2:1", type: "VECTOR", name: "Mark", ...at(0, 0, 50, 50), absoluteBoundingBox: { x: 400, y: 100, width: 50, height: 50 }, fills: [solid(1, 1, 1)], fillGeometry: [{ path: "M0 0L50 0L50 50Z", windingRule: "NONZERO" }] },
        ] },
      ],
    });
    expect(out.ratio).toBe("9:16");
    expect(byName(out, "Background")).toMatchObject({ w: 1920, h: 1080, rot: -90, x: -420, y: 420 });
    expect(byName(out, "Headline").rot).toBe(0);
    expect(byName(out, "Logo")).toMatchObject({ type: "path", rot: 0 }); // a group of one vector is that vector, named like the group
  });
});

describe("Figma import: turned frames", () => {
  it("rebuilds an auto layout frame turned a quarter the way it shows", () => {
    // a 1920×1080 frame turned a quarter (the way Figma's REST API gives it: x axis down, y axis left); inside, a horizontal auto layout (not turned back) shows as a column
    const T = (x: number, y: number, w: number, h: number, deg: number, bb: number[]) => ({ ...at(x, y, w, h, deg), absoluteBoundingBox: { x: bb[0], y: bb[1], width: bb[2], height: bb[3] } });
    const out = convert({
      id: "0:1", type: "FRAME", name: "Reel", ...T(0, 0, 1920, 1080, -90, [0, 0, 1080, 1920]), fills: [], children: [{
        id: "1:1", type: "FRAME", name: "Stack", ...T(100, 100, 600, 400, 0, [100, 100, 400, 600]), fills: [], clipsContent: false,
        layoutMode: "HORIZONTAL", itemSpacing: 20, paddingTop: 10, paddingRight: 30, paddingBottom: 10, paddingLeft: 30, counterAxisAlignItems: "MIN", layoutSizingHorizontal: "HUG", layoutSizingVertical: "FIXED",
        rectangleCornerRadii: [40, 0, 0, 0],
        children: [
          text("2:1", "First", T(0, 0, 300, 50, 90, [100, 130, 300, 50])),
          text("2:2", "Second", T(0, 0, 300, 50, 90, [100, 200, 300, 50]), { layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FILL" }),
        ],
      }],
    });
    const f = byName(out, "Stack");
    expect(f).toMatchObject({ type: "frame", x: 100, y: 100, w: 400, h: 600, rot: 0 });
    // its x axis points down on the page: a column, padding turned (left → top), hugging the height, the cross start on the right
    expect(f.al).toMatchObject({ d: "v", g: 20, p: [30, 10, 30, 10], hh: true, c: "end" });
    expect(f.al.rv).toBeUndefined();
    expect(f.rs).toEqual([0, 40, 0, 0]); // Figma's top-left corner shows top-right
    expect(byName(out, "First")).toMatchObject({ rot: 0, pid: f.id });
    expect(byName(out, "Second")).toMatchObject({ stc: true });
    expect(out.rasters).toEqual([]);
  });

  it("ends a radial gradient where Figma's handles do, not at the box's corners", () => {
    const stops = [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0.59, g: 0.59, b: 0.59, a: 0 } }];
    const out = convert({
      id: "0:1", type: "FRAME", name: "Post", ...at(0, 0, 1000, 1000), fills: [], children: [
        { id: "1:1", type: "ELLIPSE", name: "Light", ...at(0, 0, 800, 800), blendMode: "OVERLAY", fills: [{ type: "GRADIENT_RADIAL", gradientStops: stops, gradientHandlePositions: [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }] }] },
        { id: "1:2", type: "RECTANGLE", name: "Spot", ...at(0, 0, 400, 200), fills: [{ type: "GRADIENT_RADIAL", gradientStops: stops, gradientHandlePositions: [{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.25, y: 1 }] }] },
      ],
    });
    expect(byName(out, "Light").fill).toBe("radial-gradient(50% 50% at 50% 50%, #FFFFFF 0%, rgba(150,150,150,0) 100%)");
    expect(byName(out, "Spot").fill).toMatch(/^radial-gradient\(25% 50% at 25% 50%,/);
  });

  it("keeps a picture fill's opacity", () => {
    const out = convert({
      id: "0:1", type: "FRAME", name: "Post", ...at(0, 0, 1000, 1000), fills: [], children: [
        { id: "1:1", type: "RECTANGLE", name: "Grain", ...at(0, 0, 500, 500), opacity: 0.5, fills: [{ type: "IMAGE", imageRef: "g", opacity: 0.6, filters: { saturation: -1 } }] },
      ],
    });
    expect(byName(out, "Grain")).toMatchObject({ type: "image", op: 0.3, adj: { saturation: -100 } });
  });
});

describe("Figma import: styles", () => {
  it("keeps every shadow, every stroke, per-corner radii, italic and underline", () => {
    const out = convert({
      id: "0:1", type: "FRAME", name: "Post", ...at(0, 0, 1000, 1000), fills: [], children: [
        {
          id: "1:1", type: "RECTANGLE", name: "Card", ...at(100, 100, 400, 300), fills: [solid(1, 1, 1)], rectangleCornerRadii: [32, 32, 0, 0],
          strokes: [solid(0, 0, 0), solid(1, 0, 0)], strokeWeight: 2, strokeAlign: "OUTSIDE", strokeDashes: [6, 4],
          effects: [
            { type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 8 }, radius: 24, spread: 2 },
            { type: "INNER_SHADOW", visible: true, color: { r: 1, g: 1, b: 1, a: 0.5 }, offset: { x: 0, y: 1 }, radius: 0 },
            { type: "BACKGROUND_BLUR", visible: true, radius: 40 },
          ],
        },
        text("1:2", "Quote", at(100, 500, 400, 40), { textAutoResize: "HEIGHT", style: { fontFamily: "Inter", fontSize: 20, italic: true, textDecoration: "UNDERLINE" } }),
      ],
    });
    expect(byName(out, "Card")).toMatchObject({
      type: "rect", r: 32, rs: [32, 32, 0, 0], stroke: "#FF0000", sw: 2, sa: "outside", sd: "dash", sts: [{ c: "#000000", w: 2, a: "outside", d: "dash" }],
      shx: 0, shy: 8, shb: 24, shs: 2, sha: 0.2, fxs: [{ k: "inner", x: 0, y: 1, b: 0, c: "#FFFFFF", o: 0.5 }], bbl: 20,
    });
    expect(byName(out, "Quote")).toMatchObject({ it: true, ul: true, ah: true });
    expect(out.rasters).toEqual([]);
  });

  it("leaves grain out of a frosted-glass shape instead of rendering it without its blur", () => {
    const out = convert({
      id: "0:1", type: "FRAME", name: "Post", ...at(0, 0, 1000, 1000), fills: [], children: [
        { id: "1:1", type: "RECTANGLE", name: "Glass", ...at(0, 0, 500, 500), fills: [solid(1, 1, 1, 0.2)], effects: [{ type: "BACKGROUND_BLUR", visible: true, radius: 30 }, { type: "NOISE", visible: true }] },
      ],
    });
    expect(byName(out, "Glass")).toMatchObject({ type: "rect", bbl: 15 });
    expect(out.warnings).toContain("Noise and texture effects were left out");
  });
});
