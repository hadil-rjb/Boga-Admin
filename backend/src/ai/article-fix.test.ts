import { describe, expect, it } from "vitest";
import { cutWords, failing, fixPrompt, parseFix, type FixInput } from "./article-fix";

const para = (n: number) => `<p>${Array.from({ length: n }, (_, i) => "word" + i).join(" ")}</p>`;
const good: FixInput = {
  title: "A good title", slug: "a-good-title", meta: "m".repeat(140), sub: "Sub", alt: "Alt", img: "https://x/i.png",
  cat: "UX", t: ["a", "b", "c"], html: "<h2>One</h2>" + para(650), status: "Draft",
};
const ctx = { brand: "UX Boğa", language: "English", related: [{ title: "Other", slug: "other" }] };

describe("failing", () => {
  it("passes a complete article", () => {
    expect(Object.values(failing(good)).some(Boolean)).toBe(false);
  });
  it("finds each failing check", () => {
    const f = failing({ ...good, title: "x".repeat(70), meta: "short", sub: "", alt: "", t: ["a", ""], slug: "Bad Slug", html: para(100) });
    expect(f).toEqual({ title: true, meta: true, alt: true, sub: true, t: true, slug: true, html: true });
  });
  it("never proposes a new slug for a Live article", () => {
    expect(failing({ ...good, slug: "Bad_Slug", status: "Live" }).slug).toBe(false);
  });
});

describe("fixPrompt", () => {
  it("asks nothing for a complete article without proofreading", () => {
    expect(fixPrompt(good, ctx).asks).toBe(0);
  });
  it("asks only for the failing fields and sends a short excerpt when the body is fine", () => {
    const p = fixPrompt({ ...good, meta: "short", sub: "" }, ctx);
    expect(p.asks).toBe(2);
    expect(p.user).toContain("[META]");
    expect(p.user).toContain("[SUBTITLE]");
    expect(p.user).not.toContain("[CONTENT]");
    expect(p.user).not.toContain("<h2>");
    expect(p.maxTokens).toBe(900);
  });
  it("asks to expand a thin body and lists the articles it may link to", () => {
    const p = fixPrompt({ ...good, html: para(200) }, ctx);
    expect(p.user).toMatch(/has 200 words \(needs 600\+\) and has no <h2>/);
    expect(p.user).toContain("Other — other");
    expect(p.maxTokens).toBeGreaterThan(2500);
  });
  it("asks for a proofread when requested", () => {
    expect(fixPrompt({ ...good, proofread: true }, ctx).user).toContain("proofread the body");
  });
});

describe("parseFix", () => {
  const bad: FixInput = { ...good, title: "An extremely long title that goes on and on well past sixty characters", meta: "short", sub: "", alt: "", t: ["a"] };
  it("keeps changes within the limits", () => {
    const r = parseFix({
      TITLE: "“A rewritten title that is still slightly too long for the limit we have”",
      META: "x ".repeat(100), SUBTITLE: "A subtitle.", ALT: "A cover", TAGS: "#ux, fintech, onboarding, extra", NOTES: "- Shortened title\n- Wrote meta",
    }, bad, new Set());
    expect((r.changes.title as string).length).toBeLessThanOrEqual(60);
    expect(r.changes.title).not.toMatch(/[“”]/);
    expect((r.changes.meta as string).length).toBeLessThanOrEqual(160);
    expect(r.changes.t).toEqual(["ux", "fintech", "onboarding"]);
    expect(r.changes.sub).toBe("A subtitle.");
    expect(r.notes).toEqual(["Shortened title", "Wrote meta"]);
  });
  it("ignores blocks for checks that already pass", () => {
    expect(parseFix({ TITLE: "Other", SLUG: "other" }, good, new Set()).changes).toEqual({});
  });
  it("cleans the HTML and drops links to unknown articles", () => {
    const r = parseFix({ CONTENT: `<h2>A</h2><script>x</script><p onclick="x">Hi <a href="/blog/other">o</a> <a href="/blog/nope">n</a></p>${para(700)}` }, { ...good, html: para(100) }, new Set(["other"]));
    expect(r.changes.html).toContain('<a href="/blog/other">o</a>');
    expect(r.changes.html).not.toMatch(/script|onclick|nope/);
    expect(r.issues).toEqual([]);
  });
  it("refuses a body that lost text", () => {
    expect(parseFix({ CONTENT: "<h2>A</h2>" + para(400) }, { ...good, html: para(500) }, new Set()).changes.html).toBeUndefined();
    expect(parseFix({ CONTENT: "<h2>A</h2>" + para(300) }, { ...good, html: "<h2>A</h2>" + para(700), proofread: true }, new Set()).changes.html).toBeUndefined();
  });
  it("reports what still fails", () => {
    expect(parseFix({ META: "too short" }, { ...good, meta: "", sub: "" }, new Set()).issues).toEqual(["meta", "sub"]);
  });
});

describe("cutWords", () => {
  it("cuts on a word boundary", () => {
    expect(cutWords("one two three four", 9)).toBe("one two");
    expect(cutWords("short", 9)).toBe("short");
  });
});

describe("refresh and snippet modes (real Search Console queries)", () => {
  const queries = [{ query: "ux audit checklist", clicks: 3, impressions: 240, position: 8.4 }, { query: "how to run a ux audit", clicks: 0, impressions: 90, position: 14.2 }];
  it("falls back to the normal fix without any query", () => {
    expect(fixPrompt({ ...good, mode: "refresh" }, ctx).asks).toBe(0);
  });
  it("refresh asks for title, meta and the full content, with the real queries and no slug", () => {
    const p = fixPrompt({ ...good, slug: "Bad Slug", mode: "refresh", focus: "ux audit checklist", queries }, ctx);
    expect(p.asks).toBe(3);
    expect(p.user).toContain("ux audit checklist | 3 | 240 | 8.4");
    expect(p.user).toContain("Main query to target: ux audit checklist");
    expect(p.user).toContain(good.html);
    expect(p.user).not.toContain("[SLUG]");
    expect(p.system).toMatch(/never invent/);
  });
  it("snippet asks for title and meta only and sends an excerpt", () => {
    const p = fixPrompt({ ...good, sub: "", mode: "snippet", queries }, ctx);
    expect(p.user.match(/^- \[(\w+)\]/gm)).toEqual(["- [TITLE]", "- [META]"]);
    expect(p.maxTokens).toBe(900);
  });
  it("keeps the query list clean and short", () => {
    const p = fixPrompt({ ...good, mode: "snippet", queries: [...Array(30)].map((_, i) => ({ query: "q" + i, clicks: 1, impressions: 2, position: 3 })) }, ctx);
    expect(p.user.match(/^q\d+ \|/gm)).toHaveLength(20);
  });
  it("takes a rewritten title and meta even when they passed, but never a meta that would fail", () => {
    const a = { ...good, mode: "snippet" as const, queries };
    expect(parseFix({ TITLE: "UX audit checklist: 12 steps that work", META: "short" }, a, new Set()).changes).toEqual({ title: "UX audit checklist: 12 steps that work" });
    expect(parseFix({ META: "x".repeat(130) }, a, new Set()).changes.meta).toHaveLength(130);
  });
  it("refresh never takes a shorter body or one without H2", () => {
    const a = { ...good, mode: "refresh" as const, queries };
    expect(parseFix({ CONTENT: "<h2>One</h2>" + para(300) }, a, new Set()).changes.html).toBeUndefined();
    expect(parseFix({ CONTENT: para(800) }, a, new Set()).changes.html).toBeUndefined();
    expect(parseFix({ CONTENT: "<h2>One</h2>" + para(700) + "<h2>FAQ</h2><h3>Q?</h3><p>A.</p>" }, a, new Set()).changes.html).toContain("FAQ");
  });
});
