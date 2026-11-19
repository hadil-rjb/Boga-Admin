import { describe, expect, it } from "vitest";
import { coverage, ctrCurve, expectedCtr, findOpportunities, queriesFor, slugOf, terms, type PageQueries } from "./opportunities";

const U = (s: string) => `https://www.uxboga.com/blog/${s}`;
const arts = [
  { slug: "ux-audit-guide", title: "UX audit: a step-by-step guide" },
  { slug: "design-systems", title: "Design systems for startups" },
  { slug: "design-systems-2", title: "Why design systems fail" },
  { slug: "onboarding", title: "Onboarding flows that convert" },
];
const page = (key: string, clicks: number, impressions: number, position: number) => ({ key, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const row = (p: string, query: string, clicks: number, impressions: number, position: number) => ({ page: U(p), query, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const data = (o: Partial<PageQueries>): PageQueries => ({ range: { start: "2026-10-20", end: "2026-11-16", days: 28 }, previous: { start: "2026-09-22", end: "2026-10-19" }, rows: [], pages: [], prevPages: [], ...o });

describe("slugOf / terms / coverage", () => {
  it("matches the exact blog slug", () => {
    expect(slugOf(U("ux-audit-guide"))).toBe("ux-audit-guide");
    expect(slugOf(U("ux-audit-guide/"))).toBe("ux-audit-guide");
    expect(slugOf(U("ux-audit-guide?x=1"))).toBe("ux-audit-guide");
    expect(slugOf("https://www.uxboga.com/about")).toBeNull();
  });
  it("normalises accents, Turkish letters and stop words", () => {
    expect(terms("Boğa: the UX Ajansı")).toEqual(["boga", "ux", "ajansi"]);
  });
  it("measures how much of a query a title covers", () => {
    expect(coverage("ux audit checklist", "UX audit: a step-by-step guide")).toBeCloseTo(2 / 3);
    expect(coverage("designer onboarding", "Onboarding for design teams")).toBe(1);
    expect(coverage("", "anything")).toBe(0);
  });
});

describe("expected CTR from the site's own pages", () => {
  const pages = [page(U("a"), 10, 1000, 7), page(U("b"), 30, 1000, 8), page(U("c"), 2, 1000, 7.5)];
  it("leaves the page itself out of its own benchmark", () => {
    const curve = ctrCurve(pages);
    expect(expectedCtr(curve, 7.5, pages[2])).toBeCloseTo(40 / 2000);
  });
  it("says nothing when the band has too little data", () => {
    expect(expectedCtr(ctrCurve([pages[0], pages[1]]), 7, pages[0])).toBeUndefined();
    expect(expectedCtr(ctrCurve(pages), 30)).toBeUndefined();
  });
});

describe("findOpportunities", () => {
  it("finds striking-distance queries on known articles only, never on brand queries", () => {
    const o = findOpportunities(data({ rows: [row("ux-audit-guide", "ux audit checklist", 2, 120, 8.2), row("unknown", "x y", 1, 500, 9), row("onboarding", "uxboga onboarding", 0, 300, 9), row("onboarding", "onboarding", 3, 10, 9)] }), arts, { brand: ["UX Boğa", "uxboga"] });
    const s = o.filter((x) => x.kind === "striking");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ slug: "ux-audit-guide", query: "ux audit checklist", action: "refresh" });
    expect(s[0].estClicks).toBeUndefined(); // no top-3 pages to estimate from: no invented number
  });

  it("estimates extra clicks from the site's own top-3 CTR", () => {
    const o = findOpportunities(data({ rows: [row("ux-audit-guide", "ux audit checklist", 2, 200, 8)], pages: [page(U("onboarding"), 50, 500, 1.5), page(U("design-systems"), 30, 300, 2.5)] }), arts);
    expect(o.find((x) => x.kind === "striking")!.estClicks).toBe(Math.round(200 * (80 / 800) - 2));
  });

  it("flags a low CTR against pages at the same position", () => {
    const pages = [page(U("ux-audit-guide"), 2, 1000, 7), page(U("design-systems"), 40, 1000, 7.5), page(U("onboarding"), 30, 1000, 8)];
    const c = findOpportunities(data({ pages }), arts).filter((x) => x.kind === "ctr");
    expect(c.map((x) => x.slug)).toEqual(["ux-audit-guide"]);
    expect(c[0].expectedCtr).toBeCloseTo(0.035);
    expect(c[0].action).toBe("snippet");
  });

  it("flags decaying pages, but not ones that only dropped out of a full list", () => {
    const o = findOpportunities(data({ pages: [page(U("onboarding"), 6, 400, 9)], prevPages: [page(U("onboarding"), 20, 500, 6), page(U("design-systems"), 20, 400, 5), page(U("ux-audit-guide"), 15, 300, 5)] }), arts);
    const d = o.filter((x) => x.kind === "decay");
    expect(d.map((x) => [x.slug, x.prevClicks, x.clicks])).toEqual([["design-systems", 20, 0], ["ux-audit-guide", 15, 0], ["onboarding", 20, 6]]);
    const full = Array.from({ length: 250 }, (_, i) => page(U("p" + i), 1, 10, 30));
    expect(findOpportunities(data({ pages: full, prevPages: [page(U("onboarding"), 20, 500, 6)] }), arts).filter((x) => x.kind === "decay")).toHaveLength(0);
  });

  it("finds content gaps: impressions, poor position, no article about it", () => {
    const o = findOpportunities(data({ rows: [row("onboarding", "saas pricing page examples", 0, 40, 34), row("ux-audit-guide", "ux audit guide", 0, 40, 25)] }), arts);
    expect(o.filter((x) => x.kind === "gap").map((x) => x.query)).toEqual(["saas pricing page examples"]);
  });

  it("finds two articles competing for one query and names the main one", () => {
    const o = findOpportunities(data({ rows: [row("design-systems", "design systems", 3, 60, 9), row("design-systems-2", "design systems", 1, 40, 12)] }), arts);
    const c = o.find((x) => x.kind === "cannibal")!;
    expect(c.pages!.map((p) => p.slug)).toEqual(["design-systems", "design-systems-2"]);
    expect(c.impressions).toBe(100);
    expect(o.filter((x) => x.kind === "striking").map((x) => x.slug)).toEqual(["design-systems"]); // not the competing one
  });

  it("returns the most valuable first", () => {
    const o = findOpportunities(data({ rows: [row("ux-audit-guide", "ux audit checklist", 0, 30, 9), row("onboarding", "onboarding flow", 0, 300, 9)] }), arts);
    expect(o[0].query).toBe("onboarding flow");
  });
});

describe("queriesFor", () => {
  it("lists one article's queries, most impressions first", () => {
    const rows = [row("onboarding", "a", 1, 10, 3), row("onboarding", "b", 0, 50, 12.345), row("design-systems", "c", 9, 99, 1)];
    expect(queriesFor(rows, "onboarding")).toEqual([{ query: "b", clicks: 0, impressions: 50, position: 12.3 }, { query: "a", clicks: 1, impressions: 10, position: 3 }]);
  });
});
