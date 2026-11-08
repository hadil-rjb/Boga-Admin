import { createHmac, timingSafeEqual } from "crypto";

/** Signed file URLs: <video> and download links cannot send the Bearer header, so they carry ?t=<exp>.<hmac> */
const TTL = 6 * 3600;
const mac = (id: string, file: string, exp: number) => createHmac("sha256", process.env.JWT_SECRET ?? "").update(`${id}:${file}:${exp}`).digest("hex");

/** file: "proxy.mp4" or "exports/<job>.mp4". Returns the relative URL path (no /api prefix) with ?t= */
export function signFile(id: string, file: string, now = Math.floor(Date.now() / 1000)): string {
  const exp = now + TTL;
  return `/footage/${id}/${file}?t=${exp}.${mac(id, file, exp)}`;
}

export function verifyFile(id: string, file: string, token: unknown, now = Math.floor(Date.now() / 1000)): boolean {
  if (!process.env.JWT_SECRET || typeof token !== "string") return false;
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < now) return false;
  return timingSafeEqual(Buffer.from(m[2], "hex"), Buffer.from(mac(id, file, exp), "hex"));
}
