import { describe, expect, it, vi } from "vitest";

// no database or decorator metadata under vitest: stand-ins for the schema classes and the services the sync calls
vi.mock("./schemas/brand.schema", () => ({ SocialBrand: class {} }));
vi.mock("./schemas/design.schema", () => ({ SocialDesign: class {} }));
vi.mock("./schemas/post.schema", () => ({ SocialPost: class {} }));
vi.mock("./schemas/template.schema", () => ({ SocialTemplate: class {} }));
vi.mock("./schemas/workspace.schema", () => ({ SocialWorkspace: class {}, WORKSPACE_ID: "default" }));
vi.mock("./publishing/connections.service", () => ({ ConnectionsService: class {} }));
vi.mock("./publishing/publisher.service", () => ({ PublisherService: class {} }));
vi.mock("./notion/notion.service", () => ({ NotionService: class {} }));
vi.mock("./versions.service", () => ({ VersionsService: class {} }));
vi.mock("./comments.service", () => ({ CommentsService: class {} }));

import { WorkspaceService } from "./workspace.service";

const q = (v: unknown) => { const o: any = { select: () => o, sort: () => o, lean: async () => structuredClone(v) }; return o; };
const matches = (doc: any, f: Record<string, any>): boolean =>
  Object.entries(f).every(([k, v]) => {
    if (k === "$or") return v.some((x: any) => matches(doc, x));
    if (v && typeof v === "object" && "$exists" in v) return (doc[k] !== undefined) === v.$exists;
    return doc[k] === v;
  });

/** In-memory social_designs: the calls the design sync and the render job make */
function designsModel() {
  const docs: any[] = [];
  const model = {
    docs,
    find: (f: any) => q(docs.filter((d) => matches(d, f))),
    findOne: (f: any) => q(docs.find((d) => matches(d, f)) ?? null),
    replaceOne: async (f: any, repl: any, o: any = {}) => {
      const i = docs.findIndex((d) => matches(d, f));
      if (i >= 0) { docs[i] = structuredClone(repl); return { matchedCount: 1 }; }
      if (o.upsert) {
        if (docs.some((d) => d.brandId === repl.brandId && d.id === repl.id)) throw Object.assign(new Error("dup"), { code: 11000 });
        docs.push(structuredClone(repl));
      }
      return { matchedCount: 0 };
    },
    bulkWrite: async (ops: any[]) => {
      for (const op of ops) if (op.replaceOne) await (model as any).replaceOne(op.replaceOne.filter, op.replaceOne.replacement, { upsert: op.replaceOne.upsert });
      return {};
    },
    deleteMany: async () => ({}),
  };
  return model;
}

function setup() {
  const designs = designsModel();
  const none = { find: () => q([]), bulkWrite: async () => ({}), deleteMany: async () => ({}), updateOne: async () => ({}), findByIdAndUpdate: async () => ({}) };
  const gone = { removeBrand: async () => {}, removeBrands: async () => {} };
  const svc = new WorkspaceService(
    none as any, designs as any, none as any, none as any, none as any,
    gone as any, gone as any, { reconcileSoon() {} } as any, { removeFor: async () => {} } as any, { removeFor: async () => {} } as any,
  );
  const save = (item: Record<string, any>, extra: Record<string, unknown> = {}) =>
    svc.applyDelta({ designs: [{ brandId: "b", item: { id: "d1", ...item }, ...extra }] } as any) as Promise<{ revs: Record<string, number>; conflicts: any[] }>;
  return { designs, save, svc };
}

const motion = (n: number) => ({ fps: 30, scenes: [{ dur: 1000 * n }] });

describe("design saves: revisions and conflicts", () => {
  it("accepts a save based on the stored revision and bumps it", async () => {
    const { save } = setup();
    expect((await save({ name: "Key events", motion: motion(1) })).revs["b|d1"]).toBe(1);
    const out = await save({ name: "Key events", motion: motion(2) }, { rev: 1 });
    expect(out.conflicts).toEqual([]);
    expect(out.revs["b|d1"]).toBe(2);
  });

  it("a save whose answer was lost (keepalive on page exit, tab closed mid-request) is not a conflict for the same client", async () => {
    const { designs, save } = setup();
    await save({ name: "Key events", motion: motion(1) }, { wid: "w1", mine: ["w1"] });
    // rev 1 -> 2, but the browser never reads the answer (pagehide keepalive): it stays on rev 1
    await save({ name: "Key events", motion: motion(2) }, { rev: 1, wid: "w2", mine: ["w2"] });
    // after the reload the same edits continue, still based on rev 1, listing the write it never heard back about
    const out = await save({ name: "Key events", motion: motion(3) }, { rev: 1, wid: "w3", mine: ["w2", "w3"] });
    expect(out.conflicts).toEqual([]);
    expect(out.revs["b|d1"]).toBe(3);
    expect(designs.docs[0].motion).toEqual(motion(3));
  });

  it("still refuses a save based on an older revision when another editor wrote the stored one", async () => {
    const { designs, save } = setup();
    await save({ name: "Key events", motion: motion(1) }, { wid: "a1", mine: ["a1"] });
    // tab A (rev 1) and tab B (rev 1): B saves first
    await save({ name: "Key events", motion: motion(5) }, { rev: 1, wid: "b1", mine: ["b1"] });
    const out = await save({ name: "Key events", motion: motion(2) }, { rev: 1, wid: "a2", mine: ["a1", "a2"] });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0].item.motion).toEqual(motion(5));
    expect(out.conflicts[0].item.wid).toBeUndefined(); // the write id stays on the server
    expect(designs.docs[0].motion).toEqual(motion(5));
  });

  it("refuses when another editor saved after this client's own lost write", async () => {
    const { save } = setup();
    await save({ name: "x", motion: motion(1) }, { wid: "a1", mine: ["a1"] });
    await save({ name: "x", motion: motion(2) }, { rev: 1, wid: "a2", mine: ["a2"] }); // answer lost
    await save({ name: "x", motion: motion(7) }, { rev: 2, wid: "b1", mine: ["b1"] }); // tab B, up to date
    const out = await save({ name: "x", motion: motion(3) }, { rev: 1, wid: "a3", mine: ["a2", "a3"] });
    expect(out.conflicts).toHaveLength(1);
  });

  it("this client's own write landing between the read and the replace is read again, not a conflict", async () => {
    const { designs, save } = setup();
    await save({ name: "x", motion: motion(1) }, { wid: "a1", mine: ["a1"] });
    const replace = designs.replaceOne;
    designs.replaceOne = async (f: any, r: any, o: any) => {
      designs.replaceOne = replace;
      Object.assign(designs.docs[0], { rev: 2, wid: "a2", motion: motion(2), hash: "h2" }); // the keepalive save lands now
      return replace(f, r, o);
    };
    const out = await save({ name: "x", motion: motion(3) }, { rev: 1, wid: "a3", mine: ["a2", "a3"] });
    expect(out.conflicts).toEqual([]);
    expect(out.revs["b|d1"]).toBe(3);
  });

  it("an id the client puts inside the design itself is not trusted as a write id", async () => {
    const { designs, save } = setup();
    await save({ name: "x", motion: motion(1) }, { wid: "b1", mine: ["b1"] });
    await save({ name: "x", motion: motion(2), wid: "forged" }, { rev: 1 });
    expect(designs.docs[0].wid).toBeUndefined();
  });

  it("a full replace (JSON backup restore) never takes a write id from the snapshot", async () => {
    const { designs, svc, save } = setup();
    await save({ name: "x", motion: motion(1) }, { wid: "a1", mine: ["a1"] });
    await svc.replace({ brands: [{ id: "b", name: "B" }], data: { b: { designs: [{ id: "d1", name: "restored", wid: "a1" }] } } } as any);
    expect(designs.docs[0].name).toBe("restored");
    expect(designs.docs[0].wid).toBeUndefined();
    // the restore is another writer: the studio's older save is a conflict again
    expect((await save({ name: "x", motion: motion(2) }, { rev: 1, wid: "a2", mine: ["a1", "a2"] })).conflicts).toHaveLength(1);
  });

  it("the sync DTO caps write ids", async () => {
    const { plainToInstance } = await import("class-transformer");
    const { validate } = await import("class-validator");
    const { ItemUpsert } = await import("./dto/workspace.dto");
    const errs = async (o: object) => (await validate(plainToInstance(ItemUpsert, { brandId: "b", item: { id: "d1" }, ...o }))).map((e) => e.property);
    expect(await errs({ wid: "w1", mine: ["w1"] })).toEqual([]);
    expect(await errs({ wid: "x".repeat(65) })).toEqual(["wid"]);
    expect(await errs({ mine: ["x".repeat(65)] })).toEqual(["mine"]);
    expect(await errs({ mine: Array.from({ length: 51 }, (_, i) => "w" + i) })).toEqual(["mine"]);
  });

  it("clients that send no write ids keep the plain revision check", async () => {
    const { save } = setup();
    await save({ name: "x", motion: motion(1) });
    await save({ name: "x", motion: motion(2) }, { rev: 1 });
    expect((await save({ name: "x", motion: motion(3) }, { rev: 1 })).conflicts).toHaveLength(1);
  });
});
