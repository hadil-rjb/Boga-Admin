import { describe, expect, it } from "vitest";
import { compareWeeks, weekBefore, weekFor, type Snap } from "./monitor";

const U = (s: string) => "https://www.uxboga.com/blog/" + s;
const r = (key: string, clicks: number, impressions: number, position: number) => ({ key, clicks, impressions, position });
const snap = (o: Partial<Snap>): Snap => ({ start: "2026-11-09", end: "2026-11-15", totals: { clicks: 0, impressions: 0, position: 0 }, pages: [], queries: [], ...o });

describe("weekFor", () => {
  it("takes the last Monday–Sunday whose Sunday is 3+ days ago", () => {
    expect(weekFor(new Date("2026-11-19T10:00:00Z"))).toEqual({ start: "2026-11-09", end: "2026-11-15" }); // Thursday
    expect(weekFor(new Date("2026-11-18T10:00:00Z"))).toEqual({ start: "2026-11-09", end: "2026-11-15" }); // Wednesday: Sunday was 3 days ago
    expect(weekFor(new Date("2026-11-17T23:00:00Z"))).toEqual({ start: "2026-11-02", end: "2026-11-08" }); // Tuesday: too early
  });
  it("finds the week before", () => {
    expect(weekBefore({ start: "2026-11-09" })).toEqual({ start: "2026-11-02", end: "2026-11-08" });
  });
});

describe("compareWeeks", () => {
  const titles = { onboarding: "Onboarding flows", audit: "UX audit guide" };
  it("reports a clear change in site clicks only", () => {
    expect(compareWeeks(snap({ totals: { clicks: 70, impressions: 1, position: 1 } }), snap({ totals: { clicks: 100, impressions: 1, position: 1 } }))[0]).toMatchObject({ kind: "traffic", tone: "neg", text: "Search clicks down 30% last week (100 → 70)" });
    expect(compareWeeks(snap({ totals: { clicks: 90, impressions: 1, position: 1 } }), snap({ totals: { clicks: 100, impressions: 1, position: 1 } }))).toEqual([]);
    expect(compareWeeks(snap({ totals: { clicks: 30, impressions: 1, position: 1 } }), snap({ totals: { clicks: 10, impressions: 1, position: 1 } }))).toEqual([]);
  });
  it("names pages that lost clicks and links to the article", () => {
    const a = compareWeeks(snap({ pages: [r(U("onboarding"), 4, 100, 5)] }), snap({ pages: [r(U("onboarding"), 20, 200, 3), r(U("audit"), 5, 50, 3), r(U("old"), 10, 90, 4)] }), titles);
    expect(a.map((x) => [x.text, x.href])).toEqual([
      ["“Onboarding flows” lost 80% of its clicks last week (20 → 4)", "/articles?edit=onboarding"],
      ["“/blog/old” lost 100% of its clicks last week (10 → 0)", "/search?tab=opportunities"],
    ]);
  });
  it("doesn't count a page missing from a full list as lost", () => {
    const full = Array.from({ length: 250 }, (_, i) => r(U("p" + i), 1, 1, 30));
    expect(compareWeeks(snap({ pages: full }), snap({ pages: [r(U("onboarding"), 20, 200, 3)] }))).toEqual([]);
  });
  it("summarises pages beyond the first three", () => {
    const prev = ["a", "b", "c", "d", "e"].map((k) => r(U(k), 10, 50, 4));
    const a = compareWeeks(snap({}), snap({ pages: prev }));
    expect(a.filter((x) => x.kind === "page-drop")).toHaveLength(4);
    expect(a.at(-1)!.text).toBe("2 more pages lost 30%+ of their clicks last week");
  });
  it("spots searches newly near page 1 and searches that left the top 10", () => {
    const a = compareWeeks(
      snap({ queries: [r("ux audit checklist", 2, 80, 8), r("design tokens", 0, 30, 15), r("already near", 1, 40, 9), r("onboarding", 3, 60, 12.5)] }),
      snap({ queries: [r("ux audit checklist", 0, 10, 31), r("already near", 1, 40, 11), r("onboarding", 9, 70, 6.2)] }));
    expect(a.map((x) => [x.kind, x.text])).toEqual([
      ["striking", "2 searches reached positions 5–20 last week, e.g. “ux audit checklist”"],
      ["lost-top10", "“onboarding” fell out of the top 10 (position 6.2 → 12.5)"],
    ]);
  });
  it("gives each alert a stable id per week", () => {
    const a = compareWeeks(snap({ totals: { clicks: 50, impressions: 1, position: 1 } }), snap({ totals: { clicks: 100, impressions: 1, position: 1 } }));
    expect(a[0].id).toBe("2026-11-15:traffic");
  });
});
