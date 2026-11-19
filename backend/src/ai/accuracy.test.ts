import { describe, expect, it } from "vitest";
import { blocks, parseReview, plain, precheck, reviewPrompt, sentencesOf } from "./accuracy";

const html = `<h2>Why 90% of teams fail</h2>
<p>Studies show that users leave a slow page within seconds. Our team likes clear forms.</p>
<p>Conversion rose by 35% after the redesign, according to <a href="https://example.org/report">this report</a>.</p>
<ul><li>Good onboarding always doubles retention for every product.</li><li>Keep labels short and clear for readers.</li></ul>
<p>About 70% of carts are abandoned on mobile devices today.</p>`;

describe("blocks & sentences", () => {
  it("knows which blocks link to an outside source", () => {
    expect(blocks(html).map((b) => b.linked)).toEqual([false, false, true, false, false, false]);
  });
  it("splits sentences without breaking on decimals", () => {
    expect(sentencesOf("It grew 2.5 times. Then it stopped! Why?")).toEqual(["It grew 2.5 times.", "Then it stopped!", "Why?"]);
  });
});

describe("precheck", () => {
  it("flags unsourced figures, vague research and absolutes, but not linked claims or headings", () => {
    const f = precheck(html);
    expect(f.map((x) => [x.kind, x.quote])).toEqual([
      ["source", "Studies show that users leave a slow page within seconds."],
      ["absolute", "Good onboarding always doubles retention for every product."],
      ["statistic", "About 70% of carts are abandoned on mobile devices today."],
    ]);
    expect(f.every((x) => x.by === "rules")).toBe(true);
  });
});

describe("reviewPrompt", () => {
  it("forbids inventing sources and sends the rule flags as hints", () => {
    const p = reviewPrompt({ title: "T", html, brand: "UX Boğa", language: "English", pre: precheck(html) });
    expect(p.system).toMatch(/never invent, name or link a source/);
    expect(p.user).toContain("- About 70% of carts");
    expect(p.user).not.toContain("<p>");
  });
});

describe("parseReview", () => {
  const pre = precheck(html);
  it("keeps only verbatim quotes and drops rewrites that add numbers or links", () => {
    const j = { flags: [
      { quote: "About 70% of carts are abandoned on mobile devices today.", issue: "statistic", why: "No source.", fix: "soften", rewrite: "Many carts are abandoned on mobile devices." },
      { quote: "Users leave after 3 seconds, says Google.", issue: "statistic", why: "Made up", fix: "cite" },
      { quote: "Good onboarding always doubles retention for every product.", issue: "absolute", fix: "soften", rewrite: "Good onboarding can raise retention by 50%." },
      { quote: "Our team likes clear forms.", issue: "bogus", fix: "bogus", why: "" },
    ] };
    const f = parseReview(j, html, pre);
    expect(f.map((x) => [x.by, x.kind, x.fix, x.rewrite ?? null])).toEqual([
      ["ai", "statistic", "soften", "Many carts are abandoned on mobile devices."],
      ["ai", "absolute", "soften", null],
      ["ai", "doubtful", "check", null],
      ["rules", "source", "cite", null],
    ]);
  });
  it("falls back to the rule flags when the answer is unusable", () => {
    expect(parseReview("nonsense", html, pre)).toEqual(pre);
  });
  it("matches quotes despite entities and spacing", () => {
    const h = "<p>Our  tool is&nbsp;the best on the market.</p>";
    expect(plain(h)).toBe("Our tool is the best on the market.");
    expect(parseReview({ flags: [{ quote: "Our tool is the best on the market.", issue: "absolute", fix: "check", why: "x" }] }, h, [])).toHaveLength(1);
  });
});
