import { describe, expect, it } from "vitest";
import { replaceQuote } from "./accuracy";

describe("replaceQuote", () => {
  it("replaces the sentence once, across spaces and &nbsp;", () => {
    const h = "<p>About 70% of carts are&nbsp;abandoned.  Next one.</p><p>About 70% of carts are abandoned.</p>";
    expect(replaceQuote(h, "About 70% of carts are abandoned.", "Many carts are abandoned.")).toBe("<p>Many carts are abandoned.  Next one.</p><p>About 70% of carts are abandoned.</p>");
  });
  it("handles encoded characters both ways", () => {
    expect(replaceQuote("<p>Fast &amp; cheap is <b>x</b>.</p>", "Fast & cheap is", "Fast & simple is")).toBe("<p>Fast &amp; simple is <b>x</b>.</p>");
  });
  it("gives up when the sentence crosses a tag", () => {
    expect(replaceQuote("<p>It is <strong>always</strong> true.</p>", "It is always true.", "It is often true.")).toBeNull();
    expect(replaceQuote("<p>x</p>", "  ", "y")).toBeNull();
  });
});
