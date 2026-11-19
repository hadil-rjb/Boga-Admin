import { describe, expect, it } from "vitest";
import { categoryOf, organize, splitName, type OrgFrame, type OrgLabel } from "./organize";

const fr = (id: string, name: string, x: number, y: number, o: Partial<OrgFrame> = {}): OrgFrame =>
  ({ id, name, page: "Page 4", x, y, w: 100, h: 125, ratio: "4:5", width: 1080, height: 1350, thumb: null, ...o });
const lab = (text: string, y: number, o: Partial<OrgLabel> = {}): OrgLabel => ({ text, page: "Page 4", x: -200, y, w: 120, h: 30, ...o });

describe("Figma library: names", () => {
  it("splits a name into the layout and its version", () => {
    expect(splitName("News 1-Blue")).toEqual({ stem: "News 1", variant: "Blue" });
    expect(splitName("Quotes 1 - Orange")).toEqual({ stem: "Quotes 1", variant: "Orange" });
    expect(splitName("IPO / Dark")).toEqual({ stem: "IPO", variant: "Dark" });
    expect(splitName("4019")).toEqual({ stem: "4019", variant: "" });
  });
});

describe("Figma library: categories", () => {
  const labels = [lab("News Post Template", 40), lab("Highlights Template", 240), lab("Events\nEmployees", 470)];
  it("takes the label level with the frame's row", () => {
    expect(categoryOf(fr("a", "x", 0, 0), labels)).toBe("News Post Template");
    expect(categoryOf(fr("b", "x", 900, 200), labels)).toBe("Highlights Template");
  });
  it("a label between two rows reaches both", () => {
    expect(categoryOf(fr("c", "x", 0, 400), labels)).toBe("Events Employees");
    expect(categoryOf(fr("d", "x", 0, 540), labels)).toBe("Events Employees");
  });
  it("a label between a short row and a tall one reaches the short one", () => {
    // square frames 100 tall on top, then 4:5 frames: the label sits in the gap, 130 below the top row's middle
    expect(categoryOf(fr("s", "x", 0, 0, { h: 100 }), [lab("Events Employees", 165)])).toBe("Events Employees");
  });
  it("prefers the frame's section, then falls back to the page", () => {
    expect(categoryOf(fr("e", "x", 0, 0, { section: "IPO" }), labels)).toBe("IPO");
    expect(categoryOf(fr("f", "x", 0, 5000), labels)).toBe("Page 4");
    expect(categoryOf(fr("g", "x", -500, 0), labels)).toBe("Page 4"); // labels to its right don't count
  });
});

describe("Figma library: organize", () => {
  it("groups a row of colour variants into one template, the first as the original", () => {
    const frames = ["Blue", "White", "Black", "Orange"].map((c, i) => fr("n" + i, "News 1-" + c, i * 110, 0));
    const [cat] = organize(frames, [lab("News Post Template", 40)]);
    expect(cat.name).toBe("News Post Template");
    expect(cat.templates).toHaveLength(1);
    expect(cat.templates[0].name).toBe("News 1");
    expect(cat.templates[0].versions.map((v) => v.name)).toEqual(["Blue", "White", "Black", "Orange"]);
    expect(cat.templates[0].versions[0].id).toBe("n0");
  });
  it("names both sizes when a colour comes in two", () => {
    const frames = [fr("a", "Q&A-Blue", 0, 0), fr("b", "Q&A-Blue", 500, 0, { ratio: "9:16", h: 178 })];
    const t = organize(frames, [lab("Q&A", 40)])[0].templates[0];
    expect(t.versions.map((v) => v.name)).toEqual(["Blue · 4:5", "Blue · 9:16"]);
  });
  it("frames with their own names stay separate templates; same names (post and story) become versions", () => {
    const frames = [fr("1", "Taimur", 0, 0), fr("2", "Omar", 110, 0), fr("3", "Taimur", 0, 140, { ratio: "1:1" })];
    const ts = organize(frames, [lab("Events", 130)])[0].templates;
    expect(ts.map((t) => t.name)).toEqual(["Taimur", "Omar"]);
    expect(ts[0].versions.map((v) => v.name)).toEqual(["4:5", "1:1"]);
  });
  it("keeps categories in reading order and at most 25 frames per template", () => {
    const many = Array.from({ length: 30 }, (_, i) => fr("m" + i, "Movers-" + i, i * 110, 300));
    const cats = organize([...many, fr("i", "IPO-Blue", 0, 0)], [lab("IPO", 40), lab("Biggest Movers", 340)]);
    expect(cats.map((c) => c.name)).toEqual(["IPO", "Biggest Movers"]);
    expect(cats[1].templates[0].versions).toHaveLength(25);
  });
});
