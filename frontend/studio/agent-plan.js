/* ============================================================
   Studio Agent, planning: what the agent's publishing tools need that has no DOM.
   The agent never publishes. read_planner summarises the planner for it (plannerView); propose_schedule and
   propose_automation check what it proposes (checkSchedule, checkAutomation) before a card is shown in the chat,
   and the card opens the studio's own Schedule post / New automation dialog filled in (engine.js), where the
   user confirms. Dates and times are strings in the workspace time zone (YYYY-MM-DD, HH:mm), so comparing them
   needs no Date in that zone. Pure, unit-tested (agent-plan.test.js).
   ============================================================ */

export const NETWORKS = ['ig', 'li', 'x', 'fb', 'tt', 'tg'];
export const NO_NETWORK = 'No network is connected. Connect one in Settings → Connected accounts.';
export const VIDEO_AUTOMATION = 'Automations publish still designs only';
const CADENCES = ['daily', 'weekdays', 'weekly'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MAX_POSTS = 60, MAX_DAYS = 31;

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
/** A real calendar day as YYYY-MM-DD (2026-02-30 is not) */
function isDate(v) {
  const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

/** The networks of a proposal: known, connected, at least one, without repeats; { list } or { error } */
function checkNetworks(raw, connected) {
  if (!connected.length) return { error: NO_NETWORK };
  const list = [...new Set(Array.isArray(raw) ? raw.map(String) : [])];
  if (!list.length) return { error: `Choose at least one network. Connected: ${connected.join(', ')}` };
  const unknown = list.find((k) => !NETWORKS.includes(k));
  if (unknown) return { error: `Unknown network "${clip(unknown, 30)}". Use: ${NETWORKS.join(', ')}` };
  const off = list.find((k) => !connected.includes(k));
  if (off) return { error: `${off} is not connected. Connected: ${connected.join(', ')}` };
  return { list };
}

/**
 * A single post proposal. ctx: { connected, now: { date, time } (workspace zone), nextFreeSlot: { date, time },
 * blocked: why the editor would refuse to schedule this design (an uploaded video with no clip), or null }.
 * Returns { value: { networks, date, time, caption, firstComment } } or { error }.
 */
export function checkSchedule(input, ctx) {
  const p = input && typeof input === 'object' ? input : {}, connected = ctx.connected || [];
  if (!connected.length) return { error: NO_NETWORK };
  if (ctx.blocked) return { error: ctx.blocked };
  const nets = checkNetworks(p.networks, connected); if (nets.error) return nets;
  let date = p.date, time = p.time;
  if (date == null && time == null) ({ date, time } = ctx.nextFreeSlot);
  else if (time == null) return { error: 'Give the time too (HH:mm)' };
  else if (date == null) return { error: 'Give the date too (YYYY-MM-DD)' };
  if (!isDate(date)) return { error: 'The date must be YYYY-MM-DD' };
  if (!isTime(time)) return { error: 'The time must be HH:mm (24 h)' };
  if (`${date} ${time}` <= `${ctx.now.date} ${ctx.now.time}`) return { error: `This time is in the past (now ${ctx.now.date} ${ctx.now.time} in the workspace time zone)` };
  return { value: { networks: nets.list, date, time, caption: clip(p.caption, 3000), firstComment: clip(p.firstComment, 1000) } };
}

/**
 * An automation proposal. ctx: { connected, kind: 'still' | 'reel' | 'video', aiReady, designName }.
 * Returns { value: { name, cadence: { kind, days, time }, networks, caption: { mode, text }, startDate, endDate }, note? } or { error }.
 */
export function checkAutomation(input, ctx) {
  const p = input && typeof input === 'object' ? input : {}, connected = ctx.connected || [];
  if (ctx.kind !== 'still') return { error: VIDEO_AUTOMATION };
  const nets = checkNetworks(p.networks, connected); if (nets.error) return nets;
  if (!CADENCES.includes(p.cadence)) return { error: `Unknown cadence "${clip(p.cadence, 30)}". Use: ${CADENCES.join(', ')}` };
  let days = [];
  if (p.cadence === 'weekly') {
    const raw = Array.isArray(p.days) ? p.days.map(Number) : [];
    days = [...new Set(raw)].sort((a, b) => a - b);
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return { error: 'weekly needs days (1 = Monday … 7 = Sunday)' };
  }
  if (p.time == null) return { error: 'Give the time of each run (HH:mm)' };
  if (!isTime(p.time)) return { error: 'The time must be HH:mm (24 h)' };
  const startDate = p.startDate || '', endDate = p.endDate || '';
  if (startDate && !isDate(startDate)) return { error: 'The start date must be YYYY-MM-DD' };
  if (endDate && !isDate(endDate)) return { error: 'The end date must be YYYY-MM-DD' };
  if (startDate && endDate && endDate < startDate) return { error: 'The end date is before the start date' };
  let mode = p.captionMode === 'ai' ? 'ai' : 'fixed', note;
  if (mode === 'ai' && !ctx.aiReady) { mode = 'fixed'; note = 'AI captions are not set up in Settings, so the caption is fixed.'; }
  const value = { name: clip(p.name, 80).trim() || clip(ctx.designName, 80), cadence: { kind: p.cadence, days, time: p.time }, networks: nets.list, caption: { mode, text: clip(p.caption, 3000) }, startDate, endDate };
  return note ? { value, note } : { value };
}

/** A rhythm in words: "Every day at 18:00", "Weekdays at 08:00", "Every Monday and Thursday at 09:00" */
export function cadenceWords({ kind, days, time }) {
  if (kind === 'daily') return `Every day at ${time}`;
  if (kind === 'weekdays') return `Weekdays at ${time}`;
  const n = (days || []).map((d) => DAY_NAMES[d - 1]).filter(Boolean);
  const list = n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] || '';
  return `Every ${list} at ${time}`;
}

/**
 * What read_planner returns (before JSON.stringify). src: { posts, designs: [{ id, name }], automations (null when
 * they could not be read), automationsError, connected, tz, today, now, days, openDesign: { id, name, kind },
 * bestTimes: { [date]: [time] }, nextFreeSlot }. Posts: not drafts, from today, within `days` (≤ 31), sorted, ≤ 60.
 */
export function plannerView(src) {
  const names = new Map((src.designs || []).map((d) => [d.id, d.name]));
  const nameOf = (id) => names.get(id) || '(deleted design)';
  const last = addDays(src.today, Math.min(Math.max(1, +src.days || 14), MAX_DAYS));
  const shown = (src.posts || []).filter((p) => p.status !== 'Draft' && p.date >= src.today && p.date <= last)
    .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : a.date + a.time > b.date + b.time ? 1 : 0));
  const od = src.openDesign || {};
  const out = {
    timeZone: src.tz, today: src.today, now: src.now, connected: src.connected || [],
    openDesign: { id: od.id, name: od.name, kind: od.kind, scheduled: shown.filter((p) => p.d === od.id).map((p) => `${p.date} ${p.time}`) },
    posts: shown.slice(0, MAX_POSTS).map((p) => ({ date: p.date, time: p.time, networks: p.pf || [], design: nameOf(p.d), status: p.status, automation: !!p.auto })),
    automations: (src.automations || []).map((a) => ({ name: a.name, design: nameOf(a.d), active: a.active !== false, cadence: cadenceWords(a.cadence || {}), networks: a.pf || [] })),
    bestTimes: src.bestTimes || {}, nextFreeSlot: src.nextFreeSlot,
  };
  if (src.automations == null && src.automationsError) out.automationsError = src.automationsError;
  return out;
}

/**
 * The lines of a proposal card in the agent's chat: { title, sub, lines }. o: { designName, dateLabel(date), netName(key) }.
 * Post: when, networks, caption. Automation: rhythm, networks, caption (or "AI caption"), then its dates when it has any.
 */
export function cardLines(p, o) {
  const nets = (p.networks || []).map((k) => o.netName(k) || k).join(', ');
  if (p.kind === 'post') return { title: 'Post', sub: o.designName, lines: [`${o.dateLabel(p.date)}, ${p.time}`, nets, ...(p.caption ? [p.caption] : [])] };
  const cap = p.caption || {}, s = p.startDate, e = p.endDate;
  const dates = s && e ? `${o.dateLabel(s)} to ${o.dateLabel(e)}` : s ? `From ${o.dateLabel(s)}` : e ? `Until ${o.dateLabel(e)}` : '';
  return { title: 'Automation', sub: p.name, lines: [cadenceWords(p.cadence || {}), nets, ...(cap.mode === 'ai' ? ['AI caption'] : cap.text ? [cap.text] : []), ...(dates ? [dates] : [])] };
}

/* ---------- times in the workspace zone (the planner's own helpers use the browser's clock) ---------- */
const minutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
/** A day's best times without the ones of today that have passed: now { date, time } in the workspace zone */
export const upcomingTimes = (now, date, times) => (date === now.date ? times.filter((t) => minutes(t) > minutes(now.time)) : [...times]);
/**
 * The next free slot, in the workspace zone: the first of each day's best times (timesFor(date)) at least 30 minutes
 * after now that is not taken (taken(date, time)), over three weeks; else tomorrow at 09:00.
 */
export function freeSlot({ now, timesFor, taken }) {
  const soon = minutes(now.time) + 30;
  for (let i = 0; i < 21; i++) {
    const date = addDays(now.date, i);
    for (const time of [...timesFor(date)].sort()) {
      if (i === 0 && minutes(time) < soon) continue;
      if (!taken(date, time)) return { date, time };
    }
  }
  return { date: addDays(now.date, 1), time: '09:00' };
}
