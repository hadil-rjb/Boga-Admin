import { describe, expect, it } from "vitest";
import { isVideoPost, videoProblem, VIDEO_ID } from "./post-video";

const v = (durationMs: number, size = 10 * 1024 ** 2) => ({ durationMs, size, width: 1080, height: 1920 });

describe("video posts", () => {
  it("footage and motion designs publish as videos, stills as images", () => {
    expect(isVideoPost({ footage: { src: "a" } })).toBe(true);
    expect(isVideoPost({ motion: { fmt: "reel" } })).toBe(true);
    expect(isVideoPost({ pages: [] })).toBe(false);
    expect(isVideoPost(null)).toBe(false);
  });
  it("a normal reel fits every network", () => {
    for (const n of ["ig", "fb", "tt", "li", "x", "tg"] as const) expect(videoProblem(n, v(20_000))).toBeNull();
  });
  it("names the network and the limit when it doesn't fit", () => {
    expect(videoProblem("x", v(163_000))).toBe("X takes videos up to 2 min: this one is 3 min.");
    expect(videoProblem("ig", v(2_000))).toBe("Instagram needs a video of at least 3 s.");
    expect(videoProblem("tg", v(30_000, 80 * 1024 ** 2))).toBe("Telegram takes videos up to 50 MB: this one is 80 MB.");
    expect(videoProblem("tt", v(11 * 60_000))).toMatch(/^TikTok takes videos up to 10 min/);
  });
  it("video ids are 24 hex characters", () => {
    expect(VIDEO_ID.test("a".repeat(24))).toBe(true);
    expect(VIDEO_ID.test("../etc/passwd")).toBe(false);
  });
});
