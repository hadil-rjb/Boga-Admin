import { open, readFile } from "fs/promises";
import type { PublishVideo } from "./types";

/** Bytes [start, end] (inclusive) of a post video, for chunked uploads */
export async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const len = end - start + 1, buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return bytesRead === len ? buf : buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}
export const readVideo = (v: PublishVideo) => readFile(v.path);
/** Waits `ms` (networks' processing polls); POLL env vars shorten it in tests */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The first line of a caption, for networks that want a title */
export const firstLine = (text: string, max: number) => [...(text.trim().split("\n")[0] || "")].slice(0, max).join("");
