import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { randomBytes } from "crypto";
import { Model } from "mongoose";
import { CanvasBoard, CanvasBoardDocument } from "./canvas.schema";
import { cleanElements, cleanViewport } from "./canvas.elements";

/** The card's miniature: up to 150 items in drawing order, with short texts and light pen strokes */
function preview(els: any[]) {
  return [...els].sort((a, b) => (a.z || 0) - (b.z || 0)).slice(-150).map((e) => {
    const o: Record<string, unknown> = { id: e.id, k: e.k, x: e.x, y: e.y, w: e.w, h: e.h };
    for (const p of ["fill", "stroke", "sw", "shape", "color", "size", "weight", "src", "fixed"]) if (e[p] !== undefined) o[p] = e[p];
    if (typeof e.text === "string") o.text = e.text.slice(0, 140);
    if (e.k === "path" && Array.isArray(e.pts)) o.pts = e.pts.length > 400 ? e.pts.filter((_: number, i: number) => Math.floor(i / 2) % Math.ceil(e.pts.length / 400) === 0) : e.pts;
    if (e.k === "connector") { o.a = e.a; o.b = e.b; }
    return o;
  });
}

const newId = () => "cv" + randomBytes(6).toString("hex");

type Out = { id: string; name: string; elements: Record<string, unknown>[]; viewport: { x: number; y: number; z: number }; rev: number; updatedAt?: Date; createdAt?: Date; updatedBy?: string };

const full = (d: any): Out => ({ id: d.id, name: d.name, elements: d.elements || [], viewport: d.viewport || { x: 0, y: 0, z: 1 }, rev: d.rev || 1, updatedAt: d.updatedAt, createdAt: d.createdAt, updatedBy: d.updatedBy });

@Injectable()
export class CanvasService {
  constructor(@InjectModel(CanvasBoard.name) private boards: Model<CanvasBoardDocument>) {}

  /** The brand's boards, newest first, without their elements (a count and a few for the card preview) */
  async list(brandId: string) {
    const docs = await this.boards.find({ brandId }).sort({ updatedAt: -1 }).lean();
    return docs.map((d: any) => ({
      id: d.id,
      name: d.name,
      rev: d.rev,
      count: (d.elements || []).length,
      // a miniature of the board: what the card needs to draw it (short texts, photo addresses, pen points)
      preview: preview(d.elements || []),
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy,
      createdBy: d.createdBy,
    }));
  }

  async get(brandId: string, id: string) {
    const d = await this.boards.findOne({ brandId, id }).lean();
    if (!d) throw new NotFoundException("This board doesn't exist anymore");
    return full(d);
  }

  async create(brandId: string, body: { name?: string; elements?: unknown; viewport?: unknown }, user?: string) {
    const d = await this.boards.create({
      brandId,
      id: newId(),
      name: (body.name || "").trim() || "Untitled board",
      elements: cleanElements(body.elements),
      viewport: cleanViewport(body.viewport),
      rev: 1,
      createdBy: user,
      updatedBy: user,
    });
    return full(d.toObject());
  }

  /**
   * Saves the board's content. `rev` is the revision the client started from: when someone saved in between,
   * the save is refused (409) with the current board, so the client can reload instead of overwriting.
   * `force` skips the check (the user chose to keep their copy).
   */
  async save(brandId: string, id: string, body: { name?: string; elements?: unknown; viewport?: unknown; rev?: number; force?: boolean }, user?: string) {
    const set: Record<string, unknown> = { updatedBy: user };
    if (body.elements !== undefined) set.elements = cleanElements(body.elements);
    if (body.viewport !== undefined) set.viewport = cleanViewport(body.viewport);
    if (typeof body.name === "string" && body.name.trim()) set.name = body.name.trim().slice(0, 80);
    const filter: Record<string, unknown> = { brandId, id };
    if (!body.force && typeof body.rev === "number") filter.rev = body.rev;
    const d = await this.boards.findOneAndUpdate(filter, { $set: set, $inc: { rev: 1 } }, { new: true }).lean();
    if (d) return { rev: d.rev, updatedAt: (d as any).updatedAt };
    const cur = await this.boards.findOne({ brandId, id }).lean();
    if (!cur) throw new NotFoundException("This board doesn't exist anymore");
    throw new ConflictException({ message: "This board was changed somewhere else", board: full(cur) });
  }

  /** Viewport only: never conflicts and doesn't bump the revision */
  async view(brandId: string, id: string, viewport: unknown) {
    await this.boards.updateOne({ brandId, id }, { $set: { viewport: cleanViewport(viewport) } }, { timestamps: false });
    return { ok: true };
  }

  async duplicate(brandId: string, id: string, user?: string) {
    const src = await this.get(brandId, id);
    return this.create(brandId, { name: src.name + " copy", elements: src.elements, viewport: src.viewport }, user);
  }

  async remove(brandId: string, id: string) {
    const r = await this.boards.deleteOne({ brandId, id });
    if (!r.deletedCount) throw new NotFoundException("This board doesn't exist anymore");
    return { ok: true };
  }
}
