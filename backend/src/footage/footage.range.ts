/** Parses a single `Range: bytes=...` header against a file size. null = no/ignored header (send 200), "unsatisfiable" = 416 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number, end: number;
  if (!m[1]) { const n = Number(m[2]); if (n === 0) return "unsatisfiable"; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
