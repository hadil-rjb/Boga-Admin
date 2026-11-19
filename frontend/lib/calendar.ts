/** Date and layout helpers for the Editorial Calendar (week time grid, month grid, list). */

export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** The Monday of the week holding `d`, at midnight */
export const monday = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

/** The days shown for a month: whole weeks from the Monday before the 1st (5 or 6 rows, 4 for a February that fits) */
export function monthCells(m: Date) {
  const first = new Date(m.getFullYear(), m.getMonth(), 1), start = monday(first);
  let cells = [...Array(42)].map((_, i) => addDays(start, i));
  while (cells[cells.length - 7].getMonth() !== first.getMonth()) cells = cells.slice(0, -7);
  return cells;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Minutes since midnight of an "HH:MM" publish time (09:00 when missing, like the article form) */
export const minutesOf = (t?: string) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : 540; };

/** The time an article gets when dropped on an hour: that hour, its own minutes */
export const dropTime = (t: string | undefined, hour: number) => `${pad(hour)}:${pad(minutesOf(t) % 60)}`;

/** Tiles that would overlap (less than `gap` minutes apart, chained) share the width: each one's lane and the lane count (input sorted by time) */
export function hourLanes(list: { time?: string }[], gap = 32) {
  const out: { i: number; n: number }[] = [];
  let start = 0;
  list.forEach((a, k) => {
    if (k && minutesOf(a.time) - minutesOf(list[k - 1].time) >= gap) start = k;
    out.push({ i: k - start, n: 0 });
    for (let j = start; j <= k; j++) out[j].n = k - start + 1;
  });
  return out;
}

/** Top of a tile on the time grid (px), kept inside the day */
export const tileTop = (t: string | undefined, hh: number) => Math.min(24 * hh - 56, Math.round((minutesOf(t) / 60) * hh) + 10);

/** Status after a move: future = Scheduled, past = Draft, a live article stays live unless moved to the future */
export function moveStatus(status: string, date: string, today: string) {
  if (!date) return "Draft";
  if (date > today) return "Scheduled";
  return status === "Live" ? "Live" : "Draft";
}

/** "GMT+1" from Date#getTimezoneOffset() */
export function gmtLabel(offset: number) {
  if (!offset) return "GMT";
  const a = Math.abs(offset), h = Math.floor(a / 60), m = a % 60;
  return `GMT${offset < 0 ? "+" : "-"}${h}${m ? ":" + pad(m) : ""}`;
}
