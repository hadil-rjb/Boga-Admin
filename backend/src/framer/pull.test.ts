import { describe, expect, it } from "vitest";
import { diff, itemToArticle, localDate, safeHtml, type Resolved } from "./pull";

const F = (id: string, type: string, extra = {}) => ({ id, name: id, type, ...extra });
const r: Resolved = {
  title: F("t", "string"), meta: F("m", "string"), sub: F("s", "formattedText"), html: F("c", "formattedText"),
  cat: F("cat", "enum", { cases: [{ id: "e1", name: "AI Fintech" }, { id: "e2", name: "Fintech SEO" }] }),
  img: F("i", "image"), date: F("d", "date"), tagFields: [F("tag1", "string"), F("tag2", "string"), F("tag3", "string")],
};
const item = {
  id: "x1", slug: "gpt-vs-gemini", draft: false,
  fieldData: {
    t: { type: "string", value: " GPT vs Gemini " }, m: { type: "string", value: "Meta text" }, s: { type: "formattedText", value: "<p>A&nbsp;subtitle</p>" },
    c: { type: "formattedText", value: '<h2 class="x">Intro</h2><p onclick="hack()">Body <a href="javascript:alert(1)">x</a></p><script>bad()</script>' },
    cat: { type: "enum", value: "e2" }, i: { type: "image", value: { url: "https://framerusercontent.com/images/a.png", altText: "Robot" } },
    d: { type: "date", value: "2026-10-05T07:30:00.000Z" }, tag1: { type: "string", value: "AI" }, tag2: { type: "string", value: "" }, tag3: { type: "string", value: "SEO" },
  },
};

describe("itemToArticle", () => {
  it("maps every matched field, enum names, tag fields, image alt and the local date", () => {
    expect(itemToArticle(item, r, "Africa/Tunis")).toEqual({
      slug: "gpt-vs-gemini", title: "GPT vs Gemini", meta: "Meta text", sub: "A subtitle", cat: "Fintech SEO", t: ["AI", "SEO"],
      html: '<h2 class="x">Intro</h2><p>Body <a href="#">x</a></p>', img: "https://framerusercontent.com/images/a.png", alt: "Robot", date: "2026-10-05", time: "08:30",
    });
  });
  it("leaves out what the collection doesn't have, and splits a single tags field", () => {
    const a = itemToArticle({ slug: "s", fieldData: { t: { type: "string", value: "T" }, g: { type: "string", value: "a, b ,c, d" } } }, { title: F("t", "string"), tags: F("g", "string"), tagFields: [] }, "UTC");
    expect(a).toEqual({ slug: "s", title: "T", t: ["a", "b", "c"] });
  });
  it("turns a plain-text body into a paragraph, escaped", () => {
    expect(itemToArticle({ slug: "s", fieldData: { c: { type: "string", value: "1 < 2" } } }, { html: F("c", "string"), tagFields: [] }, "UTC").html).toBe("<p>1 &lt; 2</p>");
  });
});

describe("safeHtml / localDate", () => {
  it("strips active content only", () => {
    expect(safeHtml('<img src="a.png" onerror="x()"><iframe src="y"></iframe><p>ok</p>')).toBe('<img src="a.png"><p>ok</p>');
  });
  it("converts to the publishing time zone", () => {
    expect(localDate("2026-03-31T23:30:00Z", "Africa/Tunis")).toEqual({ date: "2026-04-01", time: "00:30" });
    expect(localDate("nope", "UTC")).toBeNull();
  });
});

describe("diff", () => {
  const cur = { title: "GPT vs Gemini", meta: "Meta text", sub: "A subtitle", cat: "Fintech SEO", t: ["AI", "SEO"], html: "<h2>Intro</h2><p>Body x</p>", img: "https://framerusercontent.com/images/a.png?w=10", alt: "Robot", date: "2026-10-05" };
  it("ignores formatting-only differences and fields Framer doesn't have", () => {
    expect(diff(cur, itemToArticle(item, r, "Africa/Tunis"))).toEqual([]);
    expect(diff(cur, { title: "gpt  vs gemini" })).toEqual([]);
  });
  it("names the fields that really differ", () => {
    expect(diff(cur, { title: "New", t: ["AI"], html: "<p>Other text</p>", img: "https://x/b.png", date: "2026-10-06" })).toEqual(["title", "t", "html", "img", "date"]);
  });
});
