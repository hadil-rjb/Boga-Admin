import { beforeAll, describe, expect, it, vi } from "vitest";

// A fake Framer project: one collection, two published items and one draft
const fields = [{ id: "t", name: "Title", type: "string" }, { id: "c", name: "Content", type: "formattedText" }, { id: "d", name: "Date", type: "date" }];
const items = [
  { id: "i1", slug: "new-post", draft: false, fieldData: { t: { type: "string", value: "New post" }, c: { type: "formattedText", value: "<p>Hello</p>" }, d: { type: "date", value: "2026-10-05T07:30:00Z" } } },
  { id: "i2", slug: "old-post", draft: false, fieldData: { t: { type: "string", value: "Old post, renamed" }, c: { type: "formattedText", value: "<p>Same text</p>" } } },
  { id: "i3", slug: "same-post", draft: false, fieldData: { t: { type: "string", value: "Same" }, c: { type: "formattedText", value: "<p>Same</p>" } } },
  { id: "i4", slug: "draft-post", draft: true, fieldData: { t: { type: "string", value: "Draft" } } },
];
vi.mock("./framer.client", () => ({
  withFramer: async (_u: string, _k: string, fn: (f: any) => Promise<unknown>) => fn({ getCollection: async () => ({ getFields: async () => fields, getItems: async () => items }) }),
  parseFramerProject: (s: string) => s,
}));
// the Mongoose schemas need decorator metadata, which vitest doesn't emit: models are faked below anyway
vi.mock("../articles/article.schema", () => ({ Article: { name: "Article" } }));
vi.mock("./framer-settings.schema", () => ({ FramerSettings: { name: "FramerSettings" } }));
vi.mock("../share/activity.service", () => ({ ActivityService: class {} }));
let FramerService: typeof import("./framer.service").FramerService;
beforeAll(async () => { ({ FramerService } = await import("./framer.service")); });

function setup() {
  const db = new Map<string, any>([
    ["old-post", { slug: "old-post", title: "Old post", html: "<p>Same text</p>", status: "Draft", t: [] }],
    ["same-post", { slug: "same-post", title: "Same", html: "<p>Same</p>", status: "Live", t: [] }],
  ]);
  const lean = <T,>(v: T) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
  const articles = {
    find: (q: any) => lean([...db.values()].filter((a) => q.slug.$in.includes(a.slug))),
    findOne: (q: any) => lean(db.get(q.slug) ?? null),
    create: async (d: any) => { db.set(d.slug, d); return d; },
    updateOne: async (q: any, u: any) => { db.set(q.slug, { ...db.get(q.slug), ...u.$set }); },
  };
  const settings = { findOne: () => ({ select: async () => ({ projectUrl: "https://framer.com/projects/x", apiKey: "", collectionId: "col", fieldMap: {}, timezone: "Africa/Tunis" }) }) };
  const act = { record: vi.fn(async () => {}) };
  process.env.FRAMER_API_KEY = "test-key";
  const s = new FramerService(settings as any, articles as any, act as any, { getOrThrow: () => "secret", get: () => "" } as any);
  return { s, db, act };
}

describe("Get from Framer", () => {
  it("previews new, changed and identical articles, skipping drafts", async () => {
    const { s } = setup();
    const p = await s.pullPreview();
    expect(p.drafts).toBe(1);
    expect(p.items.map((x) => [x.slug, x.state, x.changes])).toEqual([["new-post", "new", []], ["old-post", "changed", ["title"]], ["same-post", "same", []]]);
  });
  it("imports only what was picked: new as Live, existing with Framer's version of the differing fields", async () => {
    const { s, db, act } = setup();
    expect(await s.pullApply(["new-post", "old-post"], { id: "u", name: "Hadil" })).toEqual({ created: 1, updated: 1 });
    expect(db.get("new-post")).toMatchObject({ title: "New post", html: "<p>Hello</p>", date: "2026-10-05", time: "08:30", status: "Live", framerState: "synced", framerItemId: "i1" });
    expect(db.get("old-post")).toMatchObject({ title: "Old post, renamed", html: "<p>Same text</p>", status: "Live", framerItemId: "i2" });
    expect(db.get("same-post").framerItemId).toBeUndefined();
    expect(act.record).toHaveBeenCalledTimes(2);
  });
});
