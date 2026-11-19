import { describe, expect, it, vi } from "vitest";
import * as X from "xlsx";
import { autoMap, buildRows, cleanSlug, headerIndex, parseCsv, parseWorkbook, plan, runImport, toDate, toHtml, toTime, type Grid } from "./import";

// The exact header row written by lib/export.ts
const EXPORT_HEAD = ["Slug", "Cover Image", "Cover Image:alt", "Title", "Meta Description", "Subtitle", "Category", "Tag 1", "Tag 2", "Tag 3", "Content", "Date"];

describe("parseCsv", () => {
  it("reads quoted fields with commas, escaped quotes and line breaks", () => {
    const csv = '﻿"Title","Content"\r\n"Hello, world","<p>A ""quote""</p>\n<p>two</p>"\r\nPlain,x\n';
    expect(parseCsv(csv)).toEqual([["Title", "Content"], ["Hello, world", '<p>A "quote"</p>\n<p>two</p>'], ["Plain", "x"]]);
  });
  it("guesses ; and tab delimiters (European Excel exports)", () => {
    expect(parseCsv("Title;Category\nA;B")).toEqual([["Title", "Category"], ["A", "B"]]);
    expect(parseCsv("Title\tCategory\nA\tB")).toEqual([["Title", "Category"], ["A", "B"]]);
  });
  it("ignores delimiters inside quotes when guessing", () => {
    expect(parseCsv('"a;b;c",d\n1,2')).toEqual([["a;b;c", "d"], ["1", "2"]]);
  });
  it("keeps a last line without a newline", () => {
    expect(parseCsv("a,b\n1,")).toEqual([["a", "b"], ["1", ""]]);
  });
});

describe("autoMap", () => {
  it("maps every Export CSV column", () => {
    expect(autoMap(EXPORT_HEAD)).toEqual(["slug", "img", "alt", "title", "meta", "sub", "cat", "t1", "t2", "t3", "html", "date"]);
  });
  it("matches aliases regardless of case, accents and punctuation", () => {
    expect(autoMap(["  POST TITLE ", "Excerpt", "catégorie", "Publish-Date", "Statut", "Featured image", "tags"])).toEqual(["title", "sub", "cat", "date", "status", "img", "tags"]);
  });
  it("matches headers that contain an alias", () => {
    expect(autoMap(["Article Title (EN)", "SEO Meta Description", "Notes"])).toEqual(["title", "meta", ""]);
  });
  it("uses each field once and ignores unknown or empty headers", () => {
    expect(autoMap(["Title", "Name", "", "Views"])).toEqual(["title", "", "", ""]);
  });
});

describe("headerIndex", () => {
  it("skips a title line above the table", () => {
    expect(headerIndex([["Blog plan Q1"], [], ["Title", "Status"], ["A", "Live"]])).toBe(2);
  });
});

describe("values", () => {
  it("reads dates in the formats sheets use", () => {
    expect(toDate("2025-10-07T00:00:00.000Z")).toBe("2025-10-07");
    expect(toDate("2025/1/5")).toBe("2025-01-05");
    expect(toDate(45937)).toBe("2025-10-07"); // Excel serial
    expect(toDate("07/10/2025")).toBe("2025-10-07"); // day first
    expect(toDate("10/27/2025")).toBe("2025-10-27"); // can only be month first
    expect(toDate("Nov 04, 2026")).toBe("2026-11-04");
    expect(toDate("4 November 2026")).toBe("2026-11-04");
    expect(toDate("2025-02-30")).toBeNull();
    expect(toDate("soon")).toBeNull();
    expect(toDate("")).toBe("");
  });
  it("reads times", () => {
    expect(toTime("9:05")).toBe("09:05");
    expect(toTime("2:30 PM")).toBe("14:30");
    expect(toTime(0.5)).toBe("12:00");
    expect(toTime("25:00")).toBeNull();
  });
  it("cleans slugs from URLs", () => {
    expect(cleanSlug("https://uxboga.com/blog/My-Post/?utm=x")).toBe("my-post");
    expect(cleanSlug("/blog/ux-design")).toBe("ux-design");
    expect(cleanSlug("Hello World")).toBe("hello-world");
  });
  it("wraps plain text in paragraphs and keeps HTML", () => {
    expect(toHtml("One <b>\nline\n\nTwo")).toBe("<p>One &lt;b&gt;<br>line</p><p>Two</p>");
    expect(toHtml("<h2>Hi</h2><p>x</p>")).toBe("<h2>Hi</h2><p>x</p>");
  });
});

describe("buildRows", () => {
  const rows: Grid = [
    ["Title", "Slug", "Status", "Date", "Tags", "Cover image"],
    ["First post", "", "", "", "a, b, c, d", "https://cdn.x/a.png"],
    ["", "orphan", "Live", "", "", ""],
    ["Second", "first-post", "Published", "2025-10-07", "", "not a url"],
    ["Existing one", "/blog/existing", "scheduled", "", "", ""],
    ["Later", "", "Planned", "Nov 04, 2026", "", ""],
    ["", "", "", "", "", ""],
  ];
  const out = buildRows(rows, 0, autoMap(rows[0]), ["existing"]);

  it("skips empty lines and keeps sheet line numbers", () => {
    expect(out.map((r) => r.line)).toEqual([2, 3, 4, 5, 6]);
  });
  it("makes the slug from the title and defaults to Draft", () => {
    expect(out[0].slug).toBe("first-post");
    expect(out[0].body.status).toBe("Draft");
    expect(out[0].body.t).toEqual(["a", "b", "c"]);
    expect(out[0].body.img).toBe("https://cdn.x/a.png");
    expect(out[0].warnings).toContain("Only the first 3 of 4 tags are kept");
  });
  it("flags a missing title and a duplicate slug in the file", () => {
    expect(out[1].errors).toEqual(["Missing title"]);
    expect(out[2].errors).toEqual(["Same slug as line 2"]);
    expect(out[2].body.status).toBe("Live");
    expect(out[2].warnings).toContain("Cover image is not a URL, left empty");
  });
  it("marks slugs that already exist and falls back to Draft when Scheduled has no date", () => {
    expect(out[3].exists).toBe(true);
    expect(out[3].body.status).toBe("Draft");
    expect(out[3].warnings).toContain("Scheduled without a date, imported as Draft");
    expect(out[4].body).toMatchObject({ status: "Scheduled", date: "2026-11-04", time: "09:00" });
  });
  it("only puts filled columns in the update fields", () => {
    expect(Object.keys(out[3].fields).sort()).toEqual(["slug", "status", "title"]);
  });
  it("re-imports an Export CSV row", () => {
    const csv = parseCsv(EXPORT_HEAD.map((h) => `"${h}"`).join(",") + '\n"ux-design","https://x/i.png","Alt","UX Design","Meta","Sub","AI Fintech","t1","t2","t3","<p>Body</p>","2025-08-14T00:00:00.000Z"');
    const [r] = buildRows(csv, headerIndex(csv), autoMap(csv[0]), []);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.body).toEqual({ slug: "ux-design", title: "UX Design", img: "https://x/i.png", alt: "Alt", meta: "Meta", sub: "Sub", cat: "AI Fintech", t: ["t1", "t2", "t3"], html: "<p>Body</p>", coverPrompt: "", date: "2025-08-14", time: "09:00", status: "Draft" });
  });
});

describe("parseWorkbook", () => {
  it("reads every sheet of an xlsx file, with dates as Excel serials", async () => {
    const wb = X.utils.book_new();
    const ws = X.utils.aoa_to_sheet([["Title", "Date"], ["Hello", new Date(Date.UTC(2025, 9, 7))]], { cellDates: false });
    X.utils.book_append_sheet(wb, ws, "Posts");
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["x"]]), "Notes");
    const buf = X.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const book = await parseWorkbook(buf);
    expect(book.sheets.map((s) => s.name)).toEqual(["Posts", "Notes"]);
    const [r] = buildRows(book.sheets[0].rows, 0, autoMap(book.sheets[0].rows[0]), []);
    expect(r.body).toMatchObject({ title: "Hello", date: "2025-10-07" });
  });
});

describe("runImport", () => {
  const rows = buildRows([["Title", "Slug"], ["New", ""], ["Old", "old"], ["", "bad"], ["Taken", ""]], 0, ["title", "slug"], ["old"]);

  it("creates new slugs, skips existing ones and reports invalid rows", async () => {
    const api = vi.fn(async (path: string, _o: { method: string }) => { if (path === "/articles" && api.mock.calls.length === 2) throw Object.assign(new Error("exists"), { status: 409 }); return {}; });
    const prog = vi.fn();
    const out = await runImport(rows, "skip", { api, onProgress: prog });
    expect(out.map((o) => [o.slug, o.result, o.reason])).toEqual([
      ["new", "created", undefined], ["old", "skipped", "Slug already exists"], ["bad", "skipped", "Missing title"], ["taken", "skipped", "Slug already exists"],
    ]);
    expect(api.mock.calls.map((c) => [c[0], c[1].method])).toEqual([["/articles", "POST"], ["/articles", "POST"]]);
    expect(prog).toHaveBeenLastCalledWith(3, 3, expect.objectContaining({ slug: "taken" }));
  });

  it("updates existing slugs with only the filled fields", async () => {
    const api = vi.fn(async () => ({}));
    const out = await runImport(rows, "update", { api });
    expect(out.find((o) => o.slug === "old")?.result).toBe("updated");
    expect(api).toHaveBeenCalledWith("/articles/old", { method: "PATCH", body: { title: "Old" }, signal: undefined });
    expect(plan(rows[1], "update")).toBe("updated");
  });

  it("waits and retries when the server doesn't answer, then fails without stopping the rest", async () => {
    let n = 0;
    const api = vi.fn(async (_p: string, o: any) => {
      if (o.body.title === "New" && n++ < 2) throw Object.assign(new Error("no answer"), { status: 0 });
      if (o.body.title === "Taken") throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      return {};
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const out = await runImport(rows, "skip", { api, sleep, waits: [1, 2, 3] });
    expect(out.find((o) => o.slug === "new")?.result).toBe("created");
    expect(out.find((o) => o.slug === "taken")).toMatchObject({ result: "failed", reason: "Bad Gateway" });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1, 2, 1, 2, 3]);
  });

  it("doesn't retry validation errors", async () => {
    const api = vi.fn(async () => { throw Object.assign(new Error("slug invalide"), { status: 400 }); });
    const out = await runImport(rows.slice(0, 1), "skip", { api, sleep: async () => {} });
    expect(api).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatchObject({ result: "failed", reason: "slug invalide" });
  });

  it("stops sending when aborted", async () => {
    const ac = new AbortController();
    const api = vi.fn(async () => { ac.abort(); return {}; });
    const out = await runImport(rows, "update", { api, signal: ac.signal });
    expect(api).toHaveBeenCalledTimes(1);
    expect(out.filter((o) => o.reason === "Import stopped").map((o) => o.slug)).toEqual(["old", "taken"]);
  });
});
