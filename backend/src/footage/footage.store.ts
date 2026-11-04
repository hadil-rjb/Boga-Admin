import { Injectable } from "@nestjs/common";
import { createReadStream, createWriteStream, existsSync, promises as fs } from "fs";
import { dirname, join, resolve } from "path";
import { randomBytes } from "crypto";
import { pipeline } from "stream/promises";

export type FootageFile = "proxy.mp4" | "look.cube" | "words.json" | "stats.json" | `exports/${string}.mp4`;

/** backend folder: the cwd when started from it, else found by walking up from this file (src/ or dist/src/) */
function backendRoot(): string {
  if (existsSync(join(process.cwd(), "nest-cli.json"))) return process.cwd();
  for (let d = __dirname; dirname(d) !== d; d = dirname(d)) if (existsSync(join(d, "nest-cli.json"))) return d;
  return process.cwd();
}

/** Footage on disk: <root>/<id>/{chunks/<i>, source.<ext>, proxy.mp4, ...} */
@Injectable()
export class FootageStore {
  readonly root = resolve(process.env.FOOTAGE_DIR || join(backendRoot(), "storage", "footage"));

  dir(id: string): string {
    if (!/^[0-9a-f]{24}$/.test(id)) throw new Error("Invalid footage id");
    return join(this.root, id);
  }

  async writeChunk(id: string, i: number, body: Buffer): Promise<void> {
    if (!Number.isInteger(i) || i < 0 || i > 1_000_000) throw new Error("Invalid chunk index");
    const d = join(this.dir(id), "chunks");
    await fs.mkdir(d, { recursive: true });
    const tmp = join(d, `${i}.${randomBytes(6).toString("hex")}.part`); // unique: overlapping retries of one index never share a temp file
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, join(d, String(i))); // a half-written chunk never counts as received
  }

  async received(id: string): Promise<number[]> {
    const names = await fs.readdir(join(this.dir(id), "chunks")).catch(() => [] as string[]);
    return names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  }

  /** Concatenates the chunks into source.<ext> (temp file, then rename). Chunks are kept: call clearChunks once the record is saved. */
  async assemble(id: string, ext: string): Promise<string> {
    if (!/^[a-z0-9]{1,8}$/i.test(ext)) throw new Error("Invalid extension");
    const idx = await this.received(id);
    if (!idx.length) throw new Error("No chunks received");
    const out = join(this.dir(id), `source.${ext.toLowerCase()}`), tmp = `${out}.${randomBytes(6).toString("hex")}.tmp`;
    const w = createWriteStream(tmp);
    try {
      for (const i of idx) await pipeline(createReadStream(join(this.dir(id), "chunks", String(i))), w, { end: false });
      await new Promise<void>((r, j) => { w.once("error", j); w.end(() => r()); });
      await fs.rename(tmp, out);
    } catch (e) {
      w.destroy();
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return out;
  }

  async clearChunks(id: string): Promise<void> {
    await fs.rm(join(this.dir(id), "chunks"), { recursive: true, force: true });
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }

  /** A saved brand look's cube: <root>/looks/<id>.cube */
  lookFile(id: string): string {
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error("Invalid look id");
    return join(this.root, "looks", `${id}.cube`);
  }

  file(id: string, name: FootageFile): string {
    if (!/^(proxy\.mp4|look\.cube|words\.json|stats\.json|exports\/[\w-]{1,64}\.mp4)$/.test(name)) throw new Error("Invalid footage file");
    return join(this.dir(id), name);
  }
}
