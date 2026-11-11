import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The real persist.ts in a fake page: localStorage, page events and fetch are stand-ins. The fake API follows
 * WorkspaceService.applyDesigns: same content → nothing written; a save based on an older revision is refused
 * unless the stored revision was written by one of the write ids the client lists as its own (`mine`).
 */

type Doc = { item: any; rev: number; wid?: string; hash: string };
const stable = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

function fakeApi() {
  const designs = new Map<string, Doc>();
  const keepalives: number[] = [];
  const hooks: { beforeGet?: () => Promise<void> | void } = {};
  const brand = { id: "b", name: "Throwaway" };
  const workspace = () => ({
    brands: [brand],
    data: { b: { designs: [...designs.values()].map((d) => ({ ...structuredClone(d.item), rev: d.rev })), posts: [] } },
    active: "b",
  });
  const patch = (body: any) => {
    const revs: Record<string, number> = {}, conflicts: any[] = [];
    for (const u of body.designs || []) {
      const { at: _at, ...item } = u.item, key = `${u.brandId}|${item.id}`, prev = designs.get(item.id), hash = stable(item);
      if (prev && prev.hash === hash) { revs[key] = prev.rev; continue; }
      const own = !!prev?.wid && Array.isArray(u.mine) && u.mine.includes(prev.wid);
      if (prev && u.rev !== undefined && u.rev !== prev.rev && !own) { conflicts.push({ brandId: u.brandId, item: structuredClone(prev.item), rev: prev.rev }); continue; }
      const rev = (prev?.rev ?? 0) + 1;
      designs.set(item.id, { item: structuredClone(item), rev, wid: u.wid, hash });
      revs[key] = rev;
    }
    return { ok: true, revs, conflicts };
  };
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || "GET";
    if (!url.endsWith("/social/workspace")) throw new Error("unexpected " + method + " " + url);
    if (method === "GET" && hooks.beforeGet) { const h = hooks.beforeGet; hooks.beforeGet = undefined; await h(); }
    const out = method === "GET" ? { workspace: workspace() } : patch(JSON.parse(String(init.body)));
    if (init.keepalive) keepalives.push(1);
    return { ok: true, status: 200, json: async () => structuredClone(out) } as any;
  });
  return { designs, fetch, keepalives, hooks, seed: (item: any) => designs.set(item.id, { item, rev: 1, hash: stable(item) }) };
}

/** One browser: localStorage survives reloads, page listeners don't */
let store: Map<string, string>;
function browser() {
  store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("window", globalThis);
  store.set("uxb.token", "t");
}

/** A page load: a fresh persist module (as after a reload), with its own page events */
async function page() {
  const p = await open();
  await p.ready;
  return p;
}
async function open() {
  const listeners = new Map<string, Set<() => void>>();
  const on = (t: string, f: () => void) => (listeners.get(t) || listeners.set(t, new Set()).get(t)!).add(f);
  const off = (t: string, f: () => void) => listeners.get(t)?.delete(f);
  vi.stubGlobal("addEventListener", on);
  vi.stubGlobal("removeEventListener", off);
  vi.stubGlobal("document", { hidden: false, addEventListener: on, removeEventListener: off });
  vi.resetModules();
  const { persist } = await import("./persist");
  persist.init({ _id: "u1", role: "admin" });
  const conflicts: any[] = [];
  const p = {
    persist, conflicts, state: null as any,
    design: () => p.state.data.b.designs.find((d: any) => d.id === "d1"),
    fire: (t: string) => listeners.get(t)?.forEach((f) => f()),
    ready: null as unknown as Promise<void>,
  };
  p.ready = persist.load().then((state) => {
    p.state = state;
    persist.onConflict((list) => conflicts.push(...list));
    persist.watch(() => p.state);
  });
  return p;
}

const flushAsync = () => new Promise((r) => setImmediate(r));

describe("persist: design revisions", () => {
  let api: ReturnType<typeof fakeApi>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    api = fakeApi();
    vi.stubGlobal("fetch", api.fetch);
    browser();
    api.seed({ id: "d1", name: "Key events", motion: { fps: 30, scenes: [{ dur: 1000 }] } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("edits saved by keepalive on page exit, then continued after the reload, make no conflicted copy", async () => {
    const p1 = await page();
    p1.design().motion.scenes[0].dur = 2000; // motion editor commit
    expect(await p1.persist.flush()).toBe(true);
    expect(api.designs.get("d1")!.rev).toBe(2);

    p1.design().motion.scenes[0].dur = 3000; // one more edit, then the page goes away (reload, Fast Refresh, tab closed)
    p1.fire("pagehide"); // keepalive save: the API writes rev 3, the page never reads the answer
    await flushAsync();
    expect(api.keepalives).toHaveLength(1);
    expect(api.designs.get("d1")!.rev).toBe(3);
    vi.clearAllTimers(); // the old page is gone

    const p2 = await page(); // reload: unsaved local edits win, revisions come from this browser's last sync
    expect(p2.design().motion.scenes[0].dur).toBe(3000);
    p2.design().motion.scenes[0].dur = 4000; // editing carries on
    expect(await p2.persist.flush()).toBe(true);
    expect(p2.conflicts).toEqual([]);
    expect(api.designs.get("d1")!.item.motion.scenes[0].dur).toBe(4000);
    expect(api.designs.get("d1")!.rev).toBe(4);
  });

  it("two tabs editing the same design still get a conflict", async () => {
    const a = await page();
    const b = await page(); // another tab: its own page, the same browser storage
    b.design().name = "Edited in B";
    expect(await b.persist.flush()).toBe(true);
    a.design().name = "Edited in A";
    await a.persist.flush();
    expect(a.conflicts).toHaveLength(1);
    expect(a.conflicts[0].item.name).toBe("Edited in B");
    expect(api.designs.get("d1")!.item.name).toBe("Edited in B");
  });

  it("a tab resuming its older local copy can't claim another tab's unanswered write", async () => {
    const a = await page(), b = await page(); // two tabs, both on rev 1
    a.design().name = "Edited in A";
    a.fire("pagehide"); // A leaves: keepalive written (rev 2), answer never read
    await flushAsync();
    expect(api.designs.get("d1")!.rev).toBe(2);
    vi.clearAllTimers();
    b.fire("pagehide"); // B leaves with nothing to send: its copy (old d1) becomes the pending local copy
    await flushAsync();
    vi.clearAllTimers();
    expect(api.keepalives).toHaveLength(1);

    const b2 = await page(); // B reloads: resumes its own local copy
    expect(b2.design().name).toBe("Key events");
    b2.design().name = "Edited in B";
    await b2.persist.flush();
    expect(b2.conflicts).toHaveLength(1);
    expect(api.designs.get("d1")!.item.name).toBe("Edited in A");
  });

  it("write ids stored by another tab while this one is loading are not claimed", async () => {
    const a = await page(), b = await page();
    b.fire("pagehide"); // B's pending local copy holds the old d1
    await flushAsync();
    vi.clearAllTimers();
    // A edits and leaves (keepalive, answer never read) while B's reload waits on GET /workspace
    api.hooks.beforeGet = async () => {
      a.design().name = "Edited in A";
      a.fire("pagehide");
      await flushAsync();
    };
    const b2 = await page();
    expect(api.designs.get("d1")!.item.name).toBe("Edited in A");
    b2.design().name = "Edited in B";
    await b2.persist.flush();
    expect(b2.conflicts).toHaveLength(1);
    expect(api.designs.get("d1")!.item.name).toBe("Edited in A");
  });

  it("a stale tab's local copy, staged after another tab saved, doesn't take that tab's revision", async () => {
    const a = await page(), b = await page(); // two tabs, both on rev 1
    a.design().name = "Edited in A";
    expect(await a.persist.flush()).toBe(true); // rev 2: A's synced state and revisions are stored
    expect(api.designs.get("d1")!.rev).toBe(2);
    b.fire("pagehide"); // B leaves with nothing to send: its copy (old d1) becomes the pending local copy
    await flushAsync();
    vi.clearAllTimers();

    const b2 = await page(); // B reloads: resumes its own local copy, based on rev 1
    expect(b2.design().name).toBe("Key events");
    b2.design().motion.scenes[0].dur = 5000;
    await b2.persist.flush();
    expect(b2.conflicts).toHaveLength(1);
    expect(b2.conflicts[0].item.name).toBe("Edited in A");
    expect(api.designs.get("d1")!.item.name).toBe("Edited in A");
    expect(api.designs.get("d1")!.rev).toBe(2);
  });

  it("a local copy from before per-tab ownership is resumed with conflicts, not overwrites", async () => {
    const a = await page();
    a.design().name = "Edited in A";
    expect(await a.persist.flush()).toBe(true); // rev 2
    // an older client's pending copy (rev 1 content) next to revisions it can't vouch for
    store.delete("boga.studio.owner:u1");
    store.set("boga.studio.pending:u1", "1");
    store.set("boga.studio.v2:u1", JSON.stringify({ brands: [{ id: "b", name: "Throwaway" }], data: { b: { designs: [{ id: "d1", name: "Key events", motion: { fps: 30, scenes: [{ dur: 1000 }] } }], posts: [] } }, active: "b" }));
    store.set("boga.studio.revs:u1", JSON.stringify([["b|d1", 2]]));
    vi.clearAllTimers();

    const b = await page();
    expect(b.design().name).toBe("Key events");
    await b.persist.flush();
    expect(b.conflicts).toHaveLength(1);
    expect(api.designs.get("d1")!.item.name).toBe("Edited in A");
  });

  it("malformed stored write ids are ignored", async () => {
    store.set("boga.studio.sent:u1", JSON.stringify({ "b|d1": ["old-shape"], "b|d2": { ids: [1], h: "x", t: Date.now() } }));
    store.set("boga.studio.pending:u1", "1");
    store.set("boga.studio.v2:u1", JSON.stringify({ brands: [{ id: "b" }], data: { b: { designs: [{ id: "d1", name: "Key events", motion: { fps: 30, scenes: [{ dur: 1000 }] } }] } }, active: "b" }));
    const p = await page();
    p.design().name = "Renamed";
    expect(await p.persist.flush()).toBe(true);
    const body = JSON.parse(String(api.fetch.mock.calls.find(([, i]) => i?.method === "PATCH")![1]!.body));
    expect(body.designs[0].mine).toEqual([body.designs[0].wid]);
  });

  it("an exit save is sized with its revisions and write ids before choosing keepalive", async () => {
    const p = await page();
    const d = p.design();
    // the plain delta fits the 60 000-byte keepalive budget, the body as sent does not
    d.name = "";
    const plain = () => JSON.stringify({ designs: [{ brandId: "b", item: d }] }).length;
    d.name = "x".repeat(60_000 - 30 - plain());
    expect(plain()).toBeLessThanOrEqual(60_000);
    p.fire("pagehide");
    await flushAsync();
    expect(api.keepalives).toHaveLength(0); // left pending for the next load instead of being cut
    expect(store.get("boga.studio.pending:u1")).toBe("1");
  });

  it("a revision confirmed by the API forgets the write ids sent before it", async () => {
    const p = await page();
    p.design().name = "One";
    await p.persist.flush();
    p.design().name = "Two";
    await p.persist.flush();
    const sent = api.fetch.mock.calls.filter(([, i]) => i?.method === "PATCH").map(([, i]) => JSON.parse(String(i!.body)).designs[0]);
    expect(sent[0].mine).toEqual([sent[0].wid]);
    expect(sent[1].mine).toEqual([sent[1].wid]);
    expect(sent[1].rev).toBe(2);
  });
});
