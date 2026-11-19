import { describe, expect, it } from "vitest";
import { audit, internalLinks, sentences } from "./seoAudit";

const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => w + i).join(" ");
const sent = (n: number) => words(n - 1) + " end.";
const base = { slug: "ux-audit-guide", title: "UX audit: a step-by-step guide", meta: "How to run a UX audit in five steps.", cat: "UX", status: "Draft" };
const ok = (items: ReturnType<typeof audit>, id: string) => items.find((x) => x.id === id)?.ok;

describe("helpers", () => {
  it("finds internal blog links, relative or absolute, once each", () => {
    expect(internalLinks('<a href="/blog/a">x</a> <a href="https://www.uxboga.com/blog/b/">y</a> <a href="/blog/a">z</a> <a href="https://x.com">e</a>')).toEqual(["a", "b"]);
  });
  it("splits sentences and ignores fragments", () => {
    expect(sentences("One two three. Four five six! Ok. Seven eight nine?")).toHaveLength(3);
  });
});

describe("audit", () => {
  it("checks where the target query appears", () => {
    const html = `<p>This guide shows how to run a UX audit on any product, step by step, with examples.</p><h2>UX audit checklist</h2><p>${sent(12)}</p>`;
    const r = audit({ ...base, html }, "ux audit");
    expect([ok(r, "q-title"), ok(r, "q-meta"), ok(r, "q-intro"), ok(r, "q-h2"), ok(r, "q-slug")]).toEqual([true, true, true, true, true]);
    const r2 = audit({ ...base, html }, "heuristic evaluation");
    expect(r2.filter((x) => x.group === "Query").every((x) => !x.ok)).toBe(true);
    expect(r2.find((x) => x.id === "q-title")!.tip).toContain("heuristic evaluation");
  });
  it("skips query checks without a query, and the slug check once Live", () => {
    expect(audit({ ...base, html: "<p>x</p>" }, "").some((x) => x.group === "Query")).toBe(false);
    expect(ok(audit({ ...base, status: "Live", html: "<p>x</p>" }, "ux audit"), "q-slug")).toBeUndefined();
  });
  it("asks for 2 internal links on long articles and suggests live ones from the same category", () => {
    const html = `<h2>A</h2><p>${words(700)}</p><a href="/blog/one">one</a>`;
    const others = [{ slug: "one", title: "One", cat: "UX", status: "Live" }, { slug: "two", title: "Two", cat: "Other", status: "Live" }, { slug: "three", title: "Three", cat: "UX", status: "Live" }, { slug: "draft", title: "Draft", cat: "UX", status: "Draft" }];
    const l = audit({ ...base, html }, "", others).find((x) => x.id === "links")!;
    expect(l.ok).toBe(false);
    expect(l.label).toContain("(1 now)");
    expect(l.tip).toContain("“Three” or “Two”");
    expect(l.tip).not.toContain("Draft");
  });
  it("flags long sentences and long paragraphs", () => {
    const r = audit({ ...base, html: `<p>${sent(40)} ${sent(40)} ${sent(10)}</p><p>${words(160)}.</p>` }, "");
    expect(ok(r, "sentences")).toBe(false);
    expect(ok(r, "paragraphs")).toBe(false);
    expect(ok(audit({ ...base, html: `<p>${sent(15)} ${sent(18)} ${sent(12)}</p>` }, ""), "sentences")).toBe(true);
  });
  it("checks headings, H1, body image alt text and an FAQ on long guides", () => {
    const html = `<h1>T</h1><p>${words(1000)}</p><h2>One</h2><img src="a.png"><img src="b.png" alt="B">`;
    const r = audit({ ...base, html }, "");
    expect(ok(r, "h2s")).toBe(false);
    expect(ok(r, "h1")).toBe(false);
    expect(r.find((x) => x.id === "img-alt")!.tip).toMatch(/^1 image without/);
    expect(ok(r, "faq")).toBe(false);
    expect(ok(audit({ ...base, html: `<p>${words(1000)}</p><h2>One</h2><h2>Two</h2><h2>FAQ</h2>` }, ""), "faq")).toBe(true);
    expect(ok(audit({ ...base, html: `<p>${words(300)}</p>` }, ""), "faq")).toBeUndefined();
  });
});
