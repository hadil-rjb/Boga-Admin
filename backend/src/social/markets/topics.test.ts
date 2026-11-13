import { describe, expect, it } from "vitest";
import { aboutTopics, parseTopics } from "./markets";

describe("news topics", () => {
  it("reads a topic list: trimmed, lower case, no duplicates, at most 12", () => {
    expect(parseTopics(" Gold, silver ,GOLD,,S&P  500")).toEqual(["gold", "silver", "s&p 500"]);
    expect(parseTopics(Array.from({ length: 20 }, (_, i) => "t" + i).join(","))).toHaveLength(12);
    expect(parseTopics(undefined)).toEqual([]);
  });
  it("keeps headlines about a topic: whole words with plurals, Arabic anywhere", () => {
    const t = parseTopics("gold, stock, s&p 500, الذهب");
    expect(aboutTopics({ title: "Gold hits a record high" }, t)).toBe(true);
    expect(aboutTopics({ title: "Golden Globes: the nominees" }, t)).toBe(false);
    expect(aboutTopics({ title: "Stocks slip as yields rise" }, t)).toBe(true);
    expect(aboutTopics({ title: "S&P 500 closes higher" }, t)).toBe(true);
    expect(aboutTopics({ title: "ارتفاع أسعار بالذهب اليوم" }, t)).toBe(true);
    expect(aboutTopics({ title: "Outlook outage", summary: "Microsoft says gold users are fine" }, t)).toBe(true); // the summary counts
    expect(aboutTopics({ title: "Microsoft Outlook outage stretches into a second day" }, t)).toBe(false);
  });
  it("keeps everything without topics", () => {
    expect(aboutTopics({ title: "Anything" }, [])).toBe(true);
  });
});
