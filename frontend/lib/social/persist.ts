import { getToken } from "@/lib/api";
import { findDataImages, replaceDataImages, uploadDataImages } from "./assets";

/**
 * Persistence adapter between the Social Media studio engine and the NestJS API (/api/social).
 *
 * - load():  reads the workspace (brands, per-brand data, settings) from the API.
 * - save():  called by the engine; caches locally and schedules a sync.
 * - watch(): autosaves any change (editor edits don't call save() themselves).
 * - reset(): deletes the workspace so the demo data is seeded again on reload.
 *
 * Sync is a delta: only brands / designs / posts that changed since the last sync are sent,
 * plus the ones this tab deleted. Items created elsewhere (another tab, the REST API) are
 * never removed by a stale tab.
 *
 * A full copy is kept in localStorage and flagged "pending" until the API confirms it, so
 * nothing is lost if the tab closes mid-request or the API is briefly unreachable. A small
 * fingerprint of the last synced state is stored too, so pending edits are diffed against
 * what this browser actually synced (and never delete items it has not seen).
 *
 * Designs are versioned: each one sent carries the revision it is based on, and the API refuses it when
 * another tab or user saved that design meanwhile. The engine then keeps both (see onConflict).
 * Each design sent also carries a write id, and the ids of this tab's writes the API hasn't confirmed
 * yet (`mine`): a save whose answer was lost (keepalive on page exit, reload or tab closed mid-request)
 * leaves the tab one revision behind its own write, which must not read as someone else's edit.
 * After a reload those ids are only claimed for a design whose local copy is the content they wrote
 * (localStorage is shared by every tab: another tab's newer write must stay a conflict).
 * For the same reason the stored synced state and revisions are stamped with the tab that wrote them, and the
 * local copy names the tab that staged it (OWNER): a resumed copy only adopts the synced state of the tab it
 * came from. A copy whose base can't be told (another tab wrote it, or an older client) is sent based on
 * revision 0, so every design saved meanwhile comes back as a conflict instead of being overwritten.
 * Images in the designs sent are uploaded as hosted assets first (see assets.ts).
 *
 * Requests use the admin session (Bearer token from the login page). Local copies are kept
 * per user, and viewers (read-only role) never write.
 *
 * The studio can be left and re-entered without a page reload: dispose() sends what is pending,
 * and the next load() starts from the in-memory workspace, so switching back is instant.
 */

export type Workspace = {
  brands: any[];
  data: Record<string, any>;
  active: string;
  set?: Record<string, unknown>;
};

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api").replace(/\/$/, "");

// Local keys, suffixed with the user id by init()
let CACHE = "boga.studio.v2";
let PENDING = "boga.studio.pending";
let BASE = "boga.studio.synced";
let REVS = "boga.studio.revs";
let SENT = "boga.studio.sent";
let OWNER = "boga.studio.owner";
const DEBOUNCE_MS = 600;
const WATCH_MS = 2000;
const KEEPALIVE_MAX = 60_000; // browsers cap keepalive bodies at 64 KB
const SENT_MAX = 20; // unconfirmed write ids kept per design

const ls = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

/** Session expired / signed out: back to the login page, then here again. */
export const toLogin = () => {
  try {
    localStorage.removeItem("uxb.token");
  } catch {}
  location.replace("/login?next=" + encodeURIComponent(location.pathname + location.hash));
};

const apiFetch = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken(), ...(init.headers || {}) },
  });
  if (res.status === 401) {
    toLogin();
    throw new Error("Session expired");
  }
  return res;
};
const authFetch = (path: string, init: RequestInit = {}) => apiFetch("/social" + path, init);

/** Hosts one studio image; resolves to its URL */
const uploadAsset = async (dataUrl: string) => {
  const res = await apiFetch("/media/assets", { method: "POST", body: JSON.stringify({ dataUrl }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return String((await res.json()).url);
};

const isWorkspace = (v: any): v is Workspace => !!v && Array.isArray(v.brands) && v.brands.length > 0 && !!v.data;

/** JSON with sorted keys, so the same content always compares equal. */
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stable((v as any)[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
};

/** cyrb53: fast 53-bit string hash, used to fingerprint items. */
const hash = (str: string) => {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

/* ---------- design revisions ---------- */
/** "<brandId>|<designId>" → revision on the API */
type Revs = Map<string, number>;
type Conflict = { brandId: string; item: any; rev: number };
/**
 * "<brandId>|<designId>" → writes sent since the revision the API last confirmed: their ids, the content
 * hash of the last one (`h`, a resumed copy claims the ids only when it holds that content) and when (`t`)
 */
type SentEntry = { ids: string[]; h: string; t: number };
type Sent = Map<string, SentEntry>;
const SENT_TTL = 7 * 24 * 3600_000;
const writeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

/** Takes the revisions the API adds to its designs out of a workspace (the engine never sees them) */
function takeRevs(w: Workspace): Revs {
  const revs: Revs = new Map();
  Object.entries(w.data || {}).forEach(([brandId, d]) =>
    (d?.designs || []).forEach((x: any) => {
      if (!x || !x.id) return;
      revs.set(`${brandId}|${x.id}`, typeof x.rev === "number" ? x.rev : 0);
      delete x.rev;
    }),
  );
  return revs;
}

/* ---------- workspace -> comparable model ---------- */
type Model = {
  items: Map<string, string>; // "b|brand" | "d|brand|id" | "p|brand|id" -> content hash
  values: Map<string, any>;
  brandOrder: string[];
  designOrder: Record<string, string[]>;
  postOrder: Record<string, string[]>;
  ws: string;
};

function toModel(w: Workspace): Model {
  const m: Model = { items: new Map(), values: new Map(), brandOrder: [], designOrder: {}, postOrder: {}, ws: hash(stable({ active: w.active, set: w.set ?? {} })) };
  const put = (k: string, compare: unknown, value: any) => {
    m.items.set(k, hash(stable(compare)));
    m.values.set(k, value);
  };
  for (const b of w.brands) {
    const id = String(b.id);
    const { designs = [], posts = [], ...content } = w.data[id] || {};
    // Brand templates are saved through their own endpoint (/brands/:id/templates), not with the kit
    const { templates: _templates, ...kit } = b;
    m.brandOrder.push(id);
    put("b|" + id, { kit, content }, { id, kit, content });
    m.designOrder[id] = designs.filter((d: any) => d && d.id).map((d: any) => (put(`d|${id}|${d.id}`, d, { brandId: id, item: d }), d.id));
    m.postOrder[id] = posts.filter((p: any) => p && p.id).map((p: any) => (put(`p|${id}|${p.id}`, p, { brandId: id, item: p }), p.id));
  }
  return m;
}

/** The synced state and revisions of one tab, stamped with it (`tab`) */
const saveSynced = (tab: string, m: Model | null, r: Revs) => {
  if (m) ls.set(BASE, JSON.stringify({ tab, items: [...m.items], brandOrder: m.brandOrder, designOrder: m.designOrder, postOrder: m.postOrder, ws: m.ws }));
  else ls.del(BASE);
  ls.set(REVS, JSON.stringify({ tab, revs: [...r] }));
};
/** The stored revisions, with the tab that wrote them (none for an older client's list) */
const loadRevs = (): { tab?: string; revs: Revs } => {
  try {
    const v = JSON.parse(ls.get(REVS) || "[]");
    return Array.isArray(v) ? { revs: new Map(v) } : { tab: typeof v?.tab === "string" ? v.tab : undefined, revs: new Map(v?.revs || []) };
  } catch {
    return { revs: new Map() };
  }
};
/** Revision 0 for every design of a local copy whose base is unknown: the API refuses it wherever a design was saved */
const unknownRevs = (local: Workspace | null): Revs => {
  const out: Revs = new Map();
  Object.entries(local?.data || {}).forEach(([brandId, d]) => (d?.designs || []).forEach((x: any) => x && x.id && out.set(`${brandId}|${x.id}`, 0)));
  return out;
};
/** Stored write ids, malformed or week-old entries dropped. One map for every tab of this user: change it per design. */
const loadSent = (): Sent => {
  const out: Sent = new Map();
  try {
    const v = JSON.parse(ls.get(SENT) || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, e] of Object.entries(v as Record<string, any>)) {
      const ok = e && typeof e === "object" && Array.isArray(e.ids) && e.ids.length > 0 && e.ids.every((x: unknown) => typeof x === "string")
        && typeof e.h === "string" && typeof e.t === "number" && Date.now() - e.t < SENT_TTL;
      if (ok) out.set(k, { ids: e.ids.slice(-SENT_MAX), h: e.h, t: e.t });
    }
  } catch {}
  return out;
};
/** Sets (or, with null, removes) one design's entry, keeping the other tabs' entries */
const putSent = (k: string, e: SentEntry | null, onlyIfOurs?: string[]) => {
  const all = loadSent();
  const cur = all.get(k);
  if (!e && (!cur || (onlyIfOurs && !cur.ids.some((id) => onlyIfOurs.includes(id))))) return;
  if (e) all.set(k, e);
  else all.delete(k);
  ls.set(SENT, JSON.stringify(Object.fromEntries(all)));
};
const designHash = (d: unknown) => hash(stable(d));
/** The stored write ids a resumed local copy may claim: only for designs whose local content is what they wrote */
function claimSent(stored: Sent, local: Workspace | null): Sent {
  const out: Sent = new Map();
  if (!local) return out;
  stored.forEach((e, k) => {
    const [brandId, id] = k.split("|");
    const d = (local.data?.[brandId]?.designs || []).find((x: any) => x && x.id === id);
    if (d && designHash(d) === e.h) out.set(k, e);
  });
  return out;
}

const loadBase = (): (Model & { tab?: string }) | null => {
  try {
    const v = JSON.parse(ls.get(BASE) || "null");
    return v && { ...v, items: new Map(v.items), values: new Map() };
  } catch {
    return null;
  }
};
/**
 * The synced state and revisions a resumed local copy is based on: those of the tab that staged it. When that
 * can't be told, no base (nothing is deleted) and revision 0 for its designs (any design saved since is a conflict).
 */
function resumeSynced(local: Workspace | null): { base: Model | null; revs: Revs } {
  const owner = ls.get(OWNER), base = loadBase(), { tab, revs } = loadRevs();
  if (owner && tab === owner && (!base || base.tab === owner)) return { base, revs };
  return { base: null, revs: unknownRevs(local) };
}

type Delta = {
  active?: string;
  set?: Record<string, unknown>;
  brandOrder?: string[];
  brands?: { id: string; kit: any; content: any }[];
  designs?: { brandId: string; item: any; rev?: number; wid?: string; mine?: string[] }[];
  posts?: { brandId: string; item: any }[];
  designOrder?: Record<string, string[]>;
  postOrder?: Record<string, string[]>;
  deleted?: { brands: string[]; designs: { brandId: string; id: string }[]; posts: { brandId: string; id: string }[] };
};

/** What changed from `base` (last state the server confirmed) to `cur`. null = nothing. */
function diff(base: Model | null, cur: Model, ws: Workspace): Delta | null {
  const d: Delta = {};
  let changed = false;
  const kinds = { b: "brands", d: "designs", p: "posts" } as const;
  cur.items.forEach((json, k) => {
    if (base?.items.get(k) === json) return;
    const list = ((d as any)[kinds[k[0] as "b"]] ||= []);
    list.push(cur.values.get(k));
    changed = true;
  });
  if (base) {
    const del: NonNullable<Delta["deleted"]> = { brands: [], designs: [], posts: [] };
    base.items.forEach((_, k) => {
      if (cur.items.has(k)) return;
      const [kind, brandId, id] = k.split("|");
      if (kind === "b") del.brands.push(brandId);
      else (kind === "d" ? del.designs : del.posts).push({ brandId, id });
    });
    if (del.brands.length || del.designs.length || del.posts.length) {
      d.deleted = del;
      changed = true;
    }
  }
  const same = (a?: string[], b?: string[]) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(base?.brandOrder, cur.brandOrder)) {
    d.brandOrder = cur.brandOrder;
    changed = true;
  }
  for (const id of cur.brandOrder) {
    if (!same(base?.designOrder[id], cur.designOrder[id])) ((d.designOrder ||= {})[id] = cur.designOrder[id]), (changed = true);
    if (!same(base?.postOrder[id], cur.postOrder[id])) ((d.postOrder ||= {})[id] = cur.postOrder[id]), (changed = true);
  }
  if (base?.ws !== cur.ws) {
    d.active = ws.active;
    d.set = ws.set ?? {};
    changed = true;
  }
  return changed ? d : null;
}

function createPersist() {
  const tab = writeId(); // this page: stamps the local copy and the synced state it writes
  let base: Model | null = null; // last state confirmed by the API (null = unknown)
  let latest = ""; // last snapshot staged by the engine
  let lastSynced = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let inflight: Promise<void> | null = null;
  let queued = false;
  let resetting = false;
  let localFailed = false;
  let onFail: (() => void) | undefined;
  let readOnly = false;
  let userId = "";
  let getState: (() => Workspace) | null = null;
  let exit: (() => void) | null = null;
  let revs: Revs = new Map(); // revisions of the designs this browser last synced
  let sent: Sent = new Map(); // writes sent since then, answer not read yet (stored before each request)
  let onConflict: ((list: Conflict[]) => void) | undefined;
  /**
   * Tab hidden: the page is still alive, so save normally and record the revisions the API answers.
   * (A keepalive request here would race the debounced save and leave this tab on stale revisions,
   * which made the next save of the same design come back as a false conflict.)
   */
  const onHidden = () => {
    if (!document.hidden || !getState) return;
    stage(JSON.stringify(getState()));
    clearTimeout(timer);
    void push();
  };

  /**
   * Each design carries the revision it is based on (none for a design the API hasn't confirmed yet), a new
   * write id, and the ids of this tab's writes since that revision. `stamp` builds that body; `post` records
   * the ids (in memory and in localStorage) before the request leaves: when its answer is lost (keepalive,
   * reload, closed tab), the next save still tells the API the newer stored revision is its own write.
   */
  const stamp = (delta: Delta) => {
    const entries: [string, SentEntry][] = [];
    if (delta.designs) {
      delta = {
        ...delta,
        designs: delta.designs.map((u) => {
          const k = `${u.brandId}|${u.item.id}`, wid = writeId(), mine = [...(sent.get(k)?.ids || []), wid].slice(-SENT_MAX);
          entries.push([k, { ids: mine, h: designHash(u.item), t: Date.now() }]);
          return { ...u, rev: revs.get(k), wid, mine };
        }),
      };
    }
    return { body: JSON.stringify(delta), entries };
  };
  const post = ({ body, entries }: ReturnType<typeof stamp>, keepalive = false) => {
    entries.forEach(([k, e]) => (sent.set(k, e), putSent(k, e)));
    return authFetch("/workspace", { method: "PATCH", body, keepalive });
  };
  const send = (delta: Delta) => post(stamp(delta));
  /** A confirmed revision (or a conflict) ends this tab's unanswered writes for that design */
  const forget = (k: string) => {
    const mine = sent.get(k);
    if (!mine) return;
    sent.delete(k);
    putSent(k, null, mine.ids);
  };

  /**
   * Images in the designs about to be sent become hosted assets: replaced in the outgoing copy and in the
   * studio's live designs (so the next snapshot matches what was synced). True when something changed.
   */
  async function hostImages(designs: NonNullable<Delta["designs"]>) {
    const items = designs.map((u) => u.item);
    const found = findDataImages(items);
    if (!found.size) return false;
    const hosted = await uploadDataImages(found, uploadAsset);
    if (!replaceDataImages(items, hosted)) return false;
    const live = getState?.();
    if (live) replaceDataImages(designs.map((u) => (live.data[u.brandId]?.designs || []).find((d: any) => d && d.id === u.item.id)).filter(Boolean), hosted);
    return true;
  }

  /** Revisions the API confirmed; designs it refused take the API's version as the synced state */
  function settle(out: { revs?: Record<string, number>; conflicts?: Conflict[] }, cur: Model) {
    // a confirmed revision includes every earlier write of this browser
    Object.entries(out.revs || {}).forEach(([k, r]) => (revs.set(k, r), forget(k)));
    const conflicts = (out.conflicts || []).filter((c) => c && c.item && c.item.id);
    conflicts.forEach((c) => {
      revs.set(`${c.brandId}|${c.item.id}`, c.rev);
      forget(`${c.brandId}|${c.item.id}`);
      cur.items.set(`d|${c.brandId}|${c.item.id}`, hash(stable(c.item)));
    });
    if (conflicts.length) onConflict?.(conflicts);
  }

  async function push(): Promise<void> {
    if (readOnly || resetting || !latest || latest === lastSynced) return;
    if (inflight) {
      queued = true;
      return inflight;
    }
    // .finally runs after the assignment even when sync() has nothing to send and finishes at once
    inflight = sync(latest).finally(() => {
      inflight = null;
      if (queued) {
        queued = false;
        void push();
      }
    });
    return inflight;
  }

  async function sync(snapshot: string) {
    try {
      const ws = JSON.parse(snapshot) as Workspace;
      let cur = toModel(ws);
      let delta = diff(base, cur, ws);
      if (delta?.designs?.length && (await hostImages(delta.designs))) {
        cur = toModel(ws);
        delta = diff(base, cur, ws);
      }
      if (delta) {
        const res = await send(delta);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        settle(await res.json().catch(() => ({})), cur);
      }
      base = cur;
      lastSynced = snapshot;
      // another tab staged its copy since: the stored synced state stays the one that copy is based on
      if (ls.get(OWNER) === tab) {
        saveSynced(tab, cur, revs);
        if (snapshot === latest) ls.del(PENDING);
      }
    } catch (e) {
      console.warn("[persist] could not save to the API", e);
      if (localFailed) onFail?.();
    }
  }

  function stage(json: string) {
    if (readOnly || resetting || json === latest) return;
    latest = json;
    localFailed = !(ls.set(CACHE, json) && ls.set(PENDING, "1"));
    // the local copy is this tab's now: store the synced state it is based on with it
    if (ls.get(OWNER) !== tab) ls.set(OWNER, tab), saveSynced(tab, base, revs);
    clearTimeout(timer);
    timer = setTimeout(() => void push(), DEBOUNCE_MS);
  }

  /** Last chance when the tab closes: small deltas can still be delivered with keepalive. */
  function flushOnExit() {
    if (resetting || !latest || latest === lastSynced || inflight) return;
    try {
      const ws = JSON.parse(latest) as Workspace;
      const delta = diff(base, toModel(ws), ws);
      const out = delta && stamp(delta); // sized as sent: revisions and write ids included
      if (out && out.body.length <= KEEPALIVE_MAX) post(out, true).catch(() => {});
      // Larger changes stay "pending" in localStorage and are pushed on the next load.
    } catch {}
  }

  return {
    /** Who is signed in: scopes the local copy to this user; viewers are read-only. */
    init(user: { _id?: string; id?: string; role?: string }) {
      const id = String(user._id || user.id || "me");
      if (id !== userId) {
        // another account: forget this session's in-memory state
        userId = id;
        base = null;
        latest = lastSynced = "";
        resetting = false;
        revs = new Map();
        sent = new Map();
      }
      CACHE = `boga.studio.v2:${id}`;
      PENDING = `boga.studio.pending:${id}`;
      BASE = `boga.studio.synced:${id}`;
      REVS = `boga.studio.revs:${id}`;
      SENT = `boga.studio.sent:${id}`;
      OWNER = `boga.studio.owner:${id}`;
      readOnly = !["admin", "editor"].includes(String(user.role));
    },

    get readOnly() {
      return readOnly;
    },

    async load(): Promise<Workspace | null> {
      // Back in the workspace during this session: resume from memory (edits were pushed on leave)
      if (latest && !resetting) return JSON.parse(latest) as Workspace;
      let local: Workspace | null = null;
      try {
        const v = JSON.parse(ls.get(CACHE) || "null");
        if (isWorkspace(v)) local = v;
      } catch {}
      const pending = ls.get(PENDING) === "1" && !!local;
      // read with the local copy, before any await: another tab may write these meanwhile
      const synced = resumeSynced(local), localSent = claimSent(loadSent(), local);

      try {
        const res = await authFetch("/workspace", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { workspace } = await res.json();
        const serverRevs = isWorkspace(workspace) ? takeRevs(workspace) : new Map<string, number>();
        if (pending) {
          // Unsaved local edits win; watch() pushes what changed since this browser's last sync.
          // Without a fingerprint nothing is deleted, only upserted. The edits are based on the
          // revisions this browser synced, so a design saved elsewhere meanwhile comes back as a conflict.
          base = isWorkspace(workspace) ? synced.base : null; // empty server: send everything
          revs = isWorkspace(workspace) ? synced.revs : new Map();
          sent = isWorkspace(workspace) ? localSent : new Map();
          return local;
        }
        if (isWorkspace(workspace)) {
          base = toModel(workspace);
          revs = serverRevs;
          sent = new Map(); // the API's revisions already include every write this tab made
          ls.set(CACHE, JSON.stringify(workspace));
          ls.set(OWNER, tab);
          saveSynced(tab, base, revs);
          return workspace;
        }
        base = null;
        return local; // empty database: keep local data if any, otherwise the demo is seeded
      } catch (e) {
        console.warn("[persist] API unreachable, using the local copy", e);
        base = synced.base;
        revs = synced.revs;
        sent = localSent;
        return local;
      }
    },

    /**
     * Called when the API refused designs because they were saved elsewhere after this copy was loaded.
     * Each conflict holds the API's version (`item`): the engine keeps it and the local version as a copy.
     */
    onConflict(fn: ((list: Conflict[]) => void) | undefined) {
      onConflict = fn;
    },

    save(snapshot: Workspace, fail?: () => void) {
      if (fail) onFail = fail;
      stage(JSON.stringify(snapshot));
    },

    watch(get: () => Workspace) {
      this.dispose();
      getState = get;
      interval = setInterval(() => stage(JSON.stringify(get())), WATCH_MS);
      exit = () => {
        stage(JSON.stringify(get()));
        flushOnExit();
      };
      addEventListener("pagehide", exit);
      document.addEventListener("visibilitychange", onHidden);
    },

    /**
     * Sends what is pending right now (instead of waiting for the debounce) and resolves
     * true once the API has confirmed it. Used after create / rename / duplicate / delete.
     */
    async flush(): Promise<boolean> {
      if (readOnly || resetting) return false;
      if (getState) stage(JSON.stringify(getState()));
      clearTimeout(timer);
      for (let i = 0; i < 3 && latest && latest !== lastSynced; i++) {
        await push();
        while (inflight) await inflight;
      }
      return !latest || latest === lastSynced;
    },

    /** The studio is unmounting (e.g. switching to the Blog Admin): save now and stop watching. */
    dispose() {
      if (getState) {
        stage(JSON.stringify(getState()));
        clearTimeout(timer);
        void push();
      }
      clearInterval(interval);
      if (exit) removeEventListener("pagehide", exit);
      document.removeEventListener("visibilitychange", onHidden);
      getState = exit = null;
    },

    /** Wipes the shared social workspace (admin only). Resolves false when not allowed. */
    async reset(): Promise<boolean> {
      try {
        const res = await authFetch("/workspace", { method: "DELETE" });
        if (!res.ok) return false;
      } catch (e) {
        console.warn("[persist] could not reset the workspace on the API", e);
        return false;
      }
      resetting = true;
      clearTimeout(timer);
      clearInterval(interval);
      ls.del(CACHE);
      ls.del(PENDING);
      ls.del(BASE);
      ls.del(REVS);
      ls.del(SENT);
      ls.del(OWNER);
      revs = new Map();
      sent = new Map();
      return true;
    },

    /** Same as the Blog Admin's "Sign out" (the caller navigates to /login) */
    signOut() {
      try {
        localStorage.removeItem("uxb.token");
      } catch {}
    },
  };
}

export type Persist = ReturnType<typeof createPersist>;
export const persist = createPersist();
