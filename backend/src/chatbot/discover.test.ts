import { describe, expect, it } from "vitest";
import { findServers, importUrls, normalizeWebsite, scriptUrls } from "./discover";

describe("normalizeWebsite", () => {
  it("accepts a bare domain, www and paths", () => {
    expect(normalizeWebsite("uxboga.com")).toEqual({ origin: "https://uxboga.com", host: "uxboga.com" });
    expect(normalizeWebsite(" https://www.uxboga.com/blog?x=1 ")).toEqual({ origin: "https://www.uxboga.com", host: "uxboga.com" });
    expect(normalizeWebsite("http://localhost:4560/site").origin).toBe("http://localhost:4560");
  });
  it("rejects empty and non-web input", () => {
    expect(() => normalizeWebsite("")).toThrow(/Enter your website/);
    expect(() => normalizeWebsite("hello")).toThrow(/website address/);
    expect(() => normalizeWebsite("ftp://uxboga.com")).toThrow();
  });
});

describe("findServers", () => {
  it("reads the embed script tag", () => {
    expect(findServers(`<script src="https://bot.onrender.com/widget/uxboga-chat.js" defer></script>`)).toEqual(["https://bot.onrender.com"]);
  });
  it("reads the config object and data attribute, cleaning /api", () => {
    expect(findServers(`window.UXBogaChatConfig = { title: "x", apiUrl: "https://bot.example.com/api/" }`)).toEqual(["https://bot.example.com"]);
    expect(findServers(`<script data-api-url="https://a.test" src="/x.js">`)).toEqual(["https://a.test"]);
  });
  it("reads the Framer code component prop only when the file is about the widget", () => {
    expect(findServers(`function UXBogaChat(p){} const d={apiUrl:"https://bot.onrender.com"}`)).toEqual(["https://bot.onrender.com"]);
    expect(findServers(`const other={apiUrl:"https://unrelated.example.com"}`)).toEqual([]);
  });
  it("dedupes and keeps the script tag first", () => {
    const t = `<script src="https://a.test/widget/uxboga-chat.js"></script><script>window.UXBogaChatConfig={apiUrl:"https://a.test"}</script>`;
    expect(findServers(t)).toEqual(["https://a.test"]);
  });
});

describe("scriptUrls / importUrls", () => {
  it("collects page scripts as absolute URLs", () => {
    const h = `<script type="module" src="/main.mjs"></script><link rel="modulepreload" href="https://cdn.test/a.mjs"><script src="x.js?v=2"></script>`;
    expect(scriptUrls(h, "https://site.test/page")).toEqual(["https://site.test/main.mjs", "https://cdn.test/a.mjs", "https://site.test/x.js?v=2"]);
  });
  it("collects imported chunks", () => {
    expect(importUrls(`import("./chunk-1.mjs");import "https://cdn.test/b.mjs"`, "https://cdn.test/dir/main.mjs")).toEqual(["https://cdn.test/dir/chunk-1.mjs", "https://cdn.test/b.mjs"]);
  });
});
