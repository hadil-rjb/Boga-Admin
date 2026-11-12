# Studio Agent Phase 2 (Planner Reading, Post and Automation Proposals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Studio Agent reads the planner and proposes a scheduled post or an automation for the open design as a chat card; the card opens the existing dialog filled in, and only the user's confirmation there creates anything.

**Architecture:** Three new tools in `agent.ts`, tagged for both agent modes, plus a prompt section. The checks and the planner summary live in a new pure module, `agent-plan.js`. `engine.js` exposes the planner helpers and the automations list to the agent block, teaches `openSchedule` and `openAuto` to start from a proposal, runs the tools, and draws the card from `msg.proposal`.

**Tech Stack:** NestJS (backend), vanilla ES modules in `frontend/studio/`, vitest on both sides.

**Spec:** `docs/superpowers/specs/2026-11-12-agent-schedule-design.md`

## Global Constraints

- The agent never publishes, schedules, edits, skips or deletes. The only things that create a post or an automation are the existing dialogs' own buttons.
- New tools: `read_planner`, `propose_schedule`, `propose_automation`, each tagged `["design", "animate"]`. After this: design 22 tools, animate 22 tools.
- Network keys: `ig`, `li`, `x`, `fb`, `tt`, `tg`. Cadence kinds: `daily`, `weekdays`, `weekly`; days 1–7, Monday = 1. Times `HH:mm`, dates `YYYY-MM-DD`, all in the workspace time zone (`schedTz()`).
- `read_planner`: `days` default 14, at most 31; non-draft posts only; at most 60 posts; best times for 7 days, 3 each.
- Limits: `caption` 3000 characters, `firstComment` 1000, automation `name` 80.
- `PLAN_PROMPT` is added in both modes only when the context carries `design.kind` (same condition as `MAKE_VIDEO_HINT`). A request without `design.kind` gets exactly today's prompt.
- A card adds no Undo step and does not change the design. It is stored on the chat message as `msg.proposal` and saved with `d.chat`.
- Copy, exact: buttons `Review and schedule`, `Review automation`, `Dismiss`, `Open planner`, `Open automations`; states `Scheduled`, `Created`, `Dismissed`, `Design deleted`; error `Automations publish still designs only`; error `No network is connected. Connect one in Settings → Connected accounts.`
- Copy style: sentence case, verbs first, no "please" or "successfully", no emoji.
- Do not commit unless the user asks. Each task ends with its tests green.
- Test commands: `cd backend && npx vitest run src/ai/agent.test.ts`; `cd frontend && npx vitest run studio/agent-plan.test.js`; everything: `cd backend && npx vitest run` and `cd frontend && npx vitest run studio`.

## Review Focus

1. The proposed time is today, a few minutes from now, in a workspace time zone different from the browser's: the past-time check must compare in the workspace zone (`nowIn(schedTz())`), not the browser's. (Task 2, `checkSchedule` "past in the zone" test.)
2. The model omits `date` and `time`: the proposal falls back to the next free slot, never to an empty or past time. (Task 2 test.)
3. A proposal card whose design was deleted: Review shows "This design was deleted" and the card "Design deleted", never a dialog on a missing design. (Task 4 wiring; not checkable in the browser without deleting a design, so the final reviewer reads it.)
4. The automation dialog, opened from a card in the editor, must not navigate away from the editor after Create. (Task 3 ruling; not checkable in the browser without creating a real automation, so the final reviewer reads it.)
5. A conversation saved with a proposal reloads: the card renders from `d.chat` with its state (open, dismissed). (Task 4 browser check 6.)

---

### Task 1: Backend: the three tools and the plan prompt

**Files:**
- Modify: `backend/src/ai/agent.ts`
- Test: `backend/src/ai/agent.test.ts`

**Interfaces:**
- Produces: tools `read_planner`, `propose_schedule`, `propose_automation` in `AGENT_TOOLS` (modes `["design", "animate"]`); `PLAN_PROMPT: string`; `agentSystemPrompt` adds it when `saysKind(context)`.

- [ ] **Step 1: Write the failing tests** (in `describe('agent modes')`; import `PLAN_PROMPT`)

```ts
it('gives both modes the three planning tools', () => {
  ['read_planner', 'propose_schedule', 'propose_automation'].forEach((n) => { expect(names('design')).toContain(n); expect(names('animate')).toContain(n); });
});
it('adds the plan section in both modes for a studio that says what the design is, never for an older tab', () => {
  const still = JSON.stringify({ design: { mode: 'design', kind: 'still' } }), video = JSON.stringify({ design: { mode: 'animate', kind: 'video' } });
  expect(agentSystemPrompt(still, 'design')).toContain(PLAN_PROMPT);
  expect(agentSystemPrompt(video, 'animate')).toContain(PLAN_PROMPT);
  expect(agentSystemPrompt('{}', 'design')).toBe(AGENT_PROMPT);
  expect(agentSystemPrompt('{}', 'animate')).not.toContain(PLAN_PROMPT);
});
it('says the planning tools only propose, and names the caption fields', () => {
  const t = (n: string) => AGENT_TOOLS.find((x) => x.name === n)!.description;
  expect(t('propose_schedule')).toMatch(/nothing is scheduled/i);
  expect(t('propose_automation')).toMatch(/nothing is created/i);
  ['{date}', '{weekday}', '{week}', '{headline}', '{price}', '{website}', '{hashtags}'].forEach((f) => expect(JSON.stringify(AGENT_TOOLS.find((x) => x.name === 'propose_automation'))).toContain(f));
  expect(PLAN_PROMPT).toMatch(/Never say that something is scheduled or created/);
});
```

Change `gives each mode its 19 tools` to 22 for both modes. Existing `toBe(...)` assertions for a still or a video in design mode now expect `${AGENT_PROMPT}\n\n${MAKE_VIDEO_HINT}\n\n${PLAN_PROMPT}`; the animate one expects `ANIMATE_PROMPT` and `PLAN_PROMPT`.

- [ ] **Step 2: Run** `cd backend && npx vitest run src/ai/agent.test.ts`. Expected: FAIL (`PLAN_PROMPT` not exported, 19 tools).

- [ ] **Step 3: Implement**

- `PLAN_TOOLS: AgentTool[]`, appended to `AGENT_TOOLS`, parameters exactly as the spec's "Tools" section: `network` enum on `networks.items`; `cadence` enum; `captionMode` enum `fixed`, `ai`; `days.items` integer 1–7. Descriptions say: `propose_schedule` "… The user reviews it in the Schedule post dialog and confirms there; nothing is scheduled until they do."; `propose_automation` the same with "nothing is created", and lists the seven caption fields; `read_planner` "Read only".
- `PLAN_PROMPT`: the six lines of the spec's "Prompt" section, one `- ` line each, headed by `Publishing (planner, posts, automations):`.
- `agentSystemPrompt`: after the mode section, `saysKind(context) ? PLAN_PROMPT : ""`.

- [ ] **Step 4: Run** `cd backend && npx vitest run` and `cd backend && npx tsc --noEmit -p tsconfig.json`. Expected: all pass, no type errors.

---

### Task 2: Frontend pure helpers: `agent-plan.js`

**Files:**
- Create: `frontend/studio/agent-plan.js`
- Test: `frontend/studio/agent-plan.test.js`

**Interfaces:**
- Produces (pure, no DOM, no `Date.now()`; callers pass `now`):
  - `NETWORKS = ['ig', 'li', 'x', 'fb', 'tt', 'tg']`
  - `checkSchedule(input, ctx) → { value?, error? }` with `ctx = { connected: string[], now: { date, time }, nextFreeSlot: { date, time }, blocked: string | null }` and `value = { networks, date, time, caption, firstComment }`
  - `checkAutomation(input, ctx) → { value?, error?, note? }` with `ctx = { connected, kind: 'still' | 'reel' | 'video', aiReady: boolean, designName }` and `value = { name, cadence: { kind, days, time }, networks, caption: { mode, text }, startDate, endDate }`
  - `plannerView(src) → object` with `src = { posts, designs: [{ id, name }], automations, connected, tz, today, now, days, openDesign: { id, name, kind }, bestTimes: { [date]: string[] }, nextFreeSlot }`; `automations` may be `null` with `automationsError`
  - `cadenceWords({ kind, days, time }) → string`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, expect, it } from 'vitest';
import { checkSchedule, checkAutomation, plannerView, cadenceWords } from './agent-plan.js';

const ctx = { connected: ['ig', 'li'], now: { date: '2026-11-12', time: '15:40' }, nextFreeSlot: { date: '2026-11-13', time: '12:30' }, blocked: null };
describe('checkSchedule', () => {
  it('accepts a well formed proposal', () => {
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-13', time: '09:00', caption: 'Hi' }, ctx).value).toEqual({ networks: ['ig'], date: '2026-11-13', time: '09:00', caption: 'Hi', firstComment: '' });
  });
  it('falls back to the next free slot when no date and no time are given', () => {
    const v = checkSchedule({ networks: ['ig'] }, ctx).value; expect([v.date, v.time]).toEqual(['2026-11-13', '12:30']);
  });
  it('asks for the missing half', () => { expect(checkSchedule({ networks: ['ig'], date: '2026-11-13' }, ctx).error).toMatch(/time/); });
  it('refuses networks that are unknown or not connected, naming the connected ones', () => {
    expect(checkSchedule({ networks: ['myspace'], date: '2026-11-13', time: '09:00' }, ctx).error).toMatch(/myspace/);
    expect(checkSchedule({ networks: ['x'], date: '2026-11-13', time: '09:00' }, ctx).error).toMatch(/ig, li/);
    expect(checkSchedule({ networks: [], date: '2026-11-13', time: '09:00' }, ctx).error).toMatch(/network/);
  });
  it('says so when nothing is connected', () => { expect(checkSchedule({ networks: ['ig'] }, { ...ctx, connected: [] }).error).toBe('No network is connected. Connect one in Settings → Connected accounts.'); });
  it('refuses a malformed date or time', () => {
    expect(checkSchedule({ networks: ['ig'], date: '13/11/2026', time: '09:00' }, ctx).error).toMatch(/date/);
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-13', time: '9am' }, ctx).error).toMatch(/time/);
    expect(checkSchedule({ networks: ['ig'], date: '2026-02-30', time: '09:00' }, ctx).error).toMatch(/date/);
  });
  it('refuses a moment past in the workspace zone, and accepts one a minute ahead', () => {
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-12', time: '15:39' }, ctx).error).toMatch(/past/);
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-12', time: '15:41' }, ctx).value).toBeTruthy();
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-11', time: '23:00' }, ctx).error).toMatch(/past/);
  });
  it('refuses what the editor blocks (an uploaded video with no clip)', () => { expect(checkSchedule({ networks: ['ig'] }, { ...ctx, blocked: 'Add your video first, then schedule it.' }).error).toBe('Add your video first, then schedule it.'); });
  it('clips the caption and the first comment, and de-duplicates networks', () => {
    const v = checkSchedule({ networks: ['ig', 'ig'], date: '2026-11-13', time: '09:00', caption: 'a'.repeat(4000), firstComment: 'b'.repeat(2000) }, ctx).value;
    expect(v.networks).toEqual(['ig']); expect(v.caption).toHaveLength(3000); expect(v.firstComment).toHaveLength(1000);
  });
});

const actx = { connected: ['ig', 'tg'], kind: 'still', aiReady: true, designName: 'Daily gold' };
describe('checkAutomation', () => {
  it('accepts weekly with sorted unique days, and names it after the design by default', () => {
    expect(checkAutomation({ cadence: 'weekly', days: [4, 1, 4], time: '09:00', networks: ['ig'] }, actx).value)
      .toEqual({ name: 'Daily gold', cadence: { kind: 'weekly', days: [1, 4], time: '09:00' }, networks: ['ig'], caption: { mode: 'fixed', text: '' }, startDate: '', endDate: '' });
  });
  it('drops days for daily and weekdays', () => { expect(checkAutomation({ cadence: 'weekdays', days: [6], time: '08:00', networks: ['ig'] }, actx).value.cadence.days).toEqual([]); });
  it('needs days for weekly, a time, and a known cadence', () => {
    expect(checkAutomation({ cadence: 'weekly', days: [], time: '09:00', networks: ['ig'] }, actx).error).toMatch(/days/);
    expect(checkAutomation({ cadence: 'weekly', days: [9], time: '09:00', networks: ['ig'] }, actx).error).toMatch(/days/);
    expect(checkAutomation({ cadence: 'daily', networks: ['ig'] }, actx).error).toMatch(/time/);
    expect(checkAutomation({ cadence: 'hourly', time: '09:00', networks: ['ig'] }, actx).error).toMatch(/daily, weekdays, weekly/);
  });
  it('refuses videos', () => {
    ['reel', 'video'].forEach((kind) => expect(checkAutomation({ cadence: 'daily', time: '09:00', networks: ['ig'] }, { ...actx, kind }).error).toBe('Automations publish still designs only'));
  });
  it('turns an AI caption into a fixed one when AI is not ready, with a note', () => {
    const r = checkAutomation({ cadence: 'daily', time: '09:00', networks: ['ig'], captionMode: 'ai', caption: 'brief' }, { ...actx, aiReady: false });
    expect(r.value.caption).toEqual({ mode: 'fixed', text: 'brief' }); expect(r.note).toMatch(/AI/);
  });
  it('refuses an end before the start, and malformed dates', () => {
    expect(checkAutomation({ cadence: 'daily', time: '09:00', networks: ['ig'], startDate: '2026-12-01', endDate: '2026-11-01' }, actx).error).toMatch(/end/i);
    expect(checkAutomation({ cadence: 'daily', time: '09:00', networks: ['ig'], startDate: 'soon' }, actx).error).toMatch(/date/);
  });
  it('checks networks as checkSchedule does', () => { expect(checkAutomation({ cadence: 'daily', time: '09:00', networks: ['li'] }, actx).error).toMatch(/ig, tg/); });
});

describe('plannerView', () => {
  const posts = [
    { d: 'a', date: '2026-11-14', time: '09:00', pf: ['ig'], status: 'Scheduled' },
    { d: 'b', date: '2026-11-13', time: '08:00', pf: ['ig', 'x'], status: 'Scheduled', auto: 'au1' },
    { d: 'a', date: '2026-11-13', time: '10:00', pf: ['li'], status: 'Draft' },
    { d: 'gone', date: '2026-11-20', time: '10:00', pf: ['li'], status: 'Published' },
    { d: 'a', date: '2026-12-30', time: '10:00', pf: ['li'], status: 'Scheduled' },
    { d: 'a', date: '2026-11-01', time: '10:00', pf: ['li'], status: 'Published' },
  ];
  const src = { posts, designs: [{ id: 'a', name: 'Gold' }, { id: 'b', name: 'Calendar' }], automations: [{ name: 'Daily', d: 'b', active: true, cadence: { kind: 'weekdays', days: [], time: '08:00' }, pf: ['ig'] }], connected: ['ig', 'li'], tz: 'Europe/Istanbul', today: '2026-11-12', now: '15:40', days: 14, openDesign: { id: 'a', name: 'Gold', kind: 'still' }, bestTimes: { '2026-11-13': ['12:30'] }, nextFreeSlot: { date: '2026-11-13', time: '12:30' } };
  it('lists non-draft posts in the window, sorted, with design names and deleted designs named', () => {
    const v = plannerView(src);
    expect(v.posts.map((p) => `${p.date} ${p.time} ${p.design}`)).toEqual(['2026-11-13 08:00 Calendar', '2026-11-14 09:00 Gold', '2026-11-20 10:00 (deleted design)']);
    expect(v.posts[0]).toEqual({ date: '2026-11-13', time: '08:00', networks: ['ig', 'x'], design: 'Calendar', status: 'Scheduled', automation: true });
  });
  it('says when the open design is already scheduled', () => { expect(plannerView(src).openDesign.scheduled).toEqual(['2026-11-14 09:00']); });
  it('describes automations in words and passes the rest through', () => {
    const v = plannerView(src);
    expect(v.automations).toEqual([{ name: 'Daily', design: 'Calendar', active: true, cadence: 'Weekdays at 08:00', networks: ['ig'] }]);
    expect([v.timeZone, v.today, v.now]).toEqual(['Europe/Istanbul', '2026-11-12', '15:40']);
    expect(v.nextFreeSlot).toEqual({ date: '2026-11-13', time: '12:30' });
  });
  it('caps the list at 60 and the window at 31 days', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ d: 'a', date: '2026-11-13', time: `${String(8 + (i % 12)).padStart(2, '0')}:00`, pf: ['ig'], status: 'Scheduled' }));
    expect(plannerView({ ...src, posts: many }).posts).toHaveLength(60);
    expect(plannerView({ ...src, days: 99 }).posts.map((p) => p.date)).toContain('2026-11-20');
    expect(plannerView({ ...src, days: 99 }).posts.map((p) => p.date)).not.toContain('2026-12-30');
  });
  it('reports automations it could not read', () => {
    const v = plannerView({ ...src, automations: null, automationsError: 'offline' });
    expect(v.automations).toEqual([]); expect(v.automationsError).toBe('offline');
  });
});

describe('cadenceWords', () => {
  it('says each rhythm in words', () => {
    expect(cadenceWords({ kind: 'daily', days: [], time: '18:00' })).toBe('Every day at 18:00');
    expect(cadenceWords({ kind: 'weekdays', days: [], time: '08:00' })).toBe('Weekdays at 08:00');
    expect(cadenceWords({ kind: 'weekly', days: [1], time: '09:00' })).toBe('Every Monday at 09:00');
    expect(cadenceWords({ kind: 'weekly', days: [1, 4], time: '09:00' })).toBe('Every Monday and Thursday at 09:00');
    expect(cadenceWords({ kind: 'weekly', days: [1, 3, 5], time: '09:00' })).toBe('Every Monday, Wednesday and Friday at 09:00');
  });
});
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run studio/agent-plan.test.js`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `agent-plan.js`.** Decisions the tests leave open:
- Date validity: `YYYY-MM-DD` that round-trips through `new Date(Date.UTC(y, m - 1, d))` (rejects 2026-02-30). Time: `/^([01]\d|2[0-3]):[0-5]\d$/`.
- Past: `date + ' ' + time <= now.date + ' ' + now.time` as strings (both are zero-padded in the workspace zone).
- Window: `today <= date <= addDays(today, min(days || 14, 31))`, computed with UTC date arithmetic on the strings.
- Error texts: `Unknown network "<k>". Use: ig, li, x, fb, tt, tg`; `<Name> is not connected. Connected: ig, li` (name from the key list itself is enough: use the key); `Give the time too (HH:mm)` / `Give the date too (YYYY-MM-DD)`; `This time is in the past (now <date> <time> in the workspace time zone)`; `weekly needs days (1 = Monday … 7 = Sunday)`; `The end date is before the start date`.

- [ ] **Step 4: Run** `cd frontend && npx vitest run studio/agent-plan.test.js`. Expected: PASS.

---

### Task 3: The dialogs start from a proposal

**Files:**
- Modify: `frontend/studio/engine.js` — planner IIFE (about line 4082: `conn`, `bestTimes`, `nextSlot`; `openSchedule` at about 4401, its `st` initialiser and `commit(kind)` at about 4535); v26 block (`openAuto` at about 8458, `submit` at about 8532, `mine`, `load`, `aiReady`).

**Interfaces:**
- Produces: module-level `let PLAN = null` set in the planner IIFE to `{ conn, bestTimes, nextSlot }`; module-level `let AUTOS = null` set in v26 to `{ list: () => mine(), load, open: openAuto, aiReady }`; `openSchedule(d, { prefill: { pf, cap, fc, date, time }, onDone: (kind) => void })`; `openAuto(null, null, { name, d, cadence, pf, caption, startDate, endDate, onDone: () => void })`.

- [ ] **Step 1: Implement**

- `openSchedule`: when `o.prefill` and not `o.post`, after `st` is built: `pf` replaces `st.pf` (only connected keys kept), `cap` sets `st.cap`, `fc` sets `st.fc` and `st.fcOpen = true`, `date` and `time` replace the defaults. In `commit(kind)`, after `save(); close();`, call `o.onDone && o.onDone(kind)`.
- `openAuto(a, preset, prefill)`: when `prefill` and not `a`, after `st` is built: `name`, `d` (and `st.build = null`), `cadence` (copy, days copied), `pf` (new Set of connected keys), `caption` (copy), `startDate`, `endDate` replace the defaults. In `submit`, after the create succeeds: when `prefill && prefill.onDone`, call it and skip `if (!onPage()) location.hash = '#/automations'`.
- Ruling to ledger: the spec says no other dialog behaviour changes; skipping the navigation applies only to a dialog opened from a card (opened from the editor, it would otherwise leave the editor). The card offers Open automations instead.

- [ ] **Step 2: Run** `cd frontend && npx vitest run studio` and `node --check frontend/studio/engine.js`. Expected: PASS, no syntax error.

The dialogs are module-scoped and cannot be opened from the console; Task 4's browser check opens them through the card.

---

### Task 4: The agent's planning tools and the card

**Files:**
- Modify: `frontend/studio/engine.js` — imports; agent v25 block (`T`, `STEP`); `agMsg` (about line 3152) and the `ACT` object next to `agSched` (about line 3256)
- Modify: `frontend/styles/studio.css`
- Test: `frontend/studio/agent-plan.test.js` (card copy helper)

**Interfaces:**
- Consumes: Task 2 `checkSchedule`, `checkAutomation`, `plannerView`, `cadenceWords`; Task 3 `PLAN`, `AUTOS`, `openSchedule` prefill, `openAuto` prefill; `videoBlocked` from `post-video.js`; `nowIn`, `schedTz`, `PLATFORMS`, `getD`, `S.posts`, `S.designs`.
- Produces: `msg.proposal = { kind: 'post' | 'automation', d, …value, state: 'open' | 'done' | 'dismissed' }`; `cardLines(proposal, { designName, dateLabel, netName }) → { title, sub, lines: string[] }` in `agent-plan.js`.

- [ ] **Step 1: Write the failing test** (`agent-plan.test.js`)

```js
describe('cardLines', () => {
  const o = { designName: 'Gold', dateLabel: (d) => (d === '2026-11-13' ? 'Fri, 13 Nov' : d), netName: (k) => ({ ig: 'Instagram', li: 'LinkedIn' }[k]) };
  it('describes a post', () => {
    expect(cardLines({ kind: 'post', networks: ['ig', 'li'], date: '2026-11-13', time: '09:00', caption: 'Hi' }, o)).toEqual({ title: 'Post', sub: 'Gold', lines: ['Fri, 13 Nov, 09:00', 'Instagram, LinkedIn', 'Hi'] });
  });
  it('describes an automation, with an AI caption and dates', () => {
    expect(cardLines({ kind: 'automation', name: 'Daily gold', cadence: { kind: 'weekdays', days: [], time: '08:00' }, networks: ['ig'], caption: { mode: 'ai', text: '' }, startDate: '2026-11-13', endDate: '' }, o))
      .toEqual({ title: 'Automation', sub: 'Daily gold', lines: ['Weekdays at 08:00', 'Instagram', 'AI caption', 'From Fri, 13 Nov'] });
  });
  it('leaves out an empty caption', () => { expect(cardLines({ kind: 'post', networks: ['ig'], date: '2026-11-13', time: '09:00', caption: '' }, o).lines).toHaveLength(2); });
});
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run studio/agent-plan.test.js`. Expected: FAIL, `cardLines` is not exported.

- [ ] **Step 3: Implement `cardLines`** in `agent-plan.js` (dates line: `From <start>`, `Until <end>`, or `<start> to <end>`; the caption line is the raw caption, clipped by CSS to three lines).

- [ ] **Step 4: The three tools in `T`, and `STEP`**

| Tool | Does | `STEP` |
| --- | --- | --- |
| `read_planner` | `await AUTOS.load()` when `AUTOS.list()` is null (catch → `automationsError`); `plannerView({...})` with `S.posts`, `S.designs` (`id`, `name`), `PLAN.conn()`, `schedTz()`, `nowIn(tz)`, `days`, the open design (`kind` as in `agMode`'s rule), `bestTimes` for the next 7 dates (`PLAN.bestTimes(conn, key, 3).map((b) => b.t)`), `PLAN.nextSlot(conn)`; returns `JSON.stringify` of it | `Reading the planner` |
| `propose_schedule` | `checkSchedule(a, { connected: PLAN.conn(), now: nowIn(schedTz()), nextFreeSlot: PLAN.nextSlot(conn), blocked: videoBlocked(ED.d) })`; on `error` throw it; else `run.msg.proposal = { kind: 'post', d: ED.d.id, ...value, state: 'open' }` | `Proposing a post` |
| `propose_automation` | `checkAutomation(a, { connected, kind: ED.d.footage ? 'video' : ED.d.motion ? 'reel' : 'still', aiReady: AUTOS.aiReady(), designName: ED.d.name })`; same handling; result text adds `note` | `Proposing an automation` |

Results as the spec words them ("… Nothing is scheduled yet." / "… Nothing is created yet."). These tools are allowed in both modes: add nothing to `DESIGN_ONLY` or `ANIMATE_ONLY`.

- [ ] **Step 5: The card**

- In `agMsg`, after `cap`: when `m.proposal`, draw `<div class="ag-cap ag-plan">` with a header (`ic('clock')` for a post, `ic('refresh')` for an automation, the title, the sub), the lines from `cardLines` (`.ag-plan-l`; the caption line `.ag-plan-c`), and a footer:
  - `state === 'open'` and `canEdit()`: primary `Review and schedule` / `Review automation` (`data-act="agPlanOpen"`), secondary `Dismiss` (`agPlanDismiss`).
  - `state === 'done'`: `Scheduled` or `Created`, and `Open planner` / `Open automations` (`agPlanGo`).
  - `state === 'dismissed'`: `Dismissed`.
  - Design missing (`!getD(p.d)`): `Design deleted`, no buttons.
- `ACT.agPlanOpen(a)`: `m = ED.d.chat[+a.dataset.i]`, `p = m.proposal`, `d = getD(p.d)`; no `d` → toast `This design was deleted`, `agThread()`; post → `openSchedule(d, { prefill: { pf: p.networks, cap: p.caption, fc: p.firstComment, date: p.date, time: p.time }, onDone: (k) => { if (k === 'schedule') { p.state = 'done'; touch(); save(); agThread(); } } })`; automation → `AUTOS.open(null, null, { name: p.name, d: p.d, cadence: p.cadence, pf: p.networks, caption: p.caption, startDate: p.startDate, endDate: p.endDate, onDone: () => { p.state = 'done'; touch(); save(); agThread(); } })`.
- `ACT.agPlanDismiss`: `p.state = 'dismissed'`, save, redraw. `ACT.agPlanGo`: `location.hash = p.kind === 'post' ? '#/planner' : '#/automations'`.
- A draft saved from the dialog does not mark the card done (it stays open to schedule).

- [ ] **Step 6: CSS** in `studio.css`: `.ag-plan-l` (one line each, muted label colour for the time line), `.ag-plan-c` (`-webkit-line-clamp: 3`), `.ag-plan-f` (footer row, buttons as `.ag-mini`; the primary one as the existing small primary button). No shadows; 1 px borders as the caption card.

- [ ] **Step 7: Run** `cd frontend && npx vitest run studio`, `node --check frontend/studio/engine.js`, `cd frontend && npm run check:css`. Expected: PASS, OK.

- [ ] **Step 8: Check in the browser** (both servers, AI key set; restart the API for Task 1; reload the page).

Never press **Schedule**, **Publish now** or **Create** in this check: the workspace has real connected accounts, and those buttons would publish or set up real posts. Stop at the filled dialog and close it, or use **Save draft**, which publishes nothing.

1. A still: "Post this tomorrow at 9 on Instagram". A post card appears with tomorrow, 09:00, Instagram. Review opens Schedule post with Instagram selected, the caption, tomorrow's date and 09:00. Close it: the card is still open, and Review opens it again the same.
2. Review, then **Save draft**: the card stays open (a draft does not complete it). Report the draft's existence to the user rather than deleting it.
3. "What's planned this week?": the steps show `Reading the planner` and the answer matches the planner page.
4. "Publish this every weekday at 8 with an AI caption": an automation card reading Weekdays at 08:00. Review opens the automation dialog with weekdays, 08:00, the networks, AI caption and this design. Close it with Cancel.
5. An animated design: "Publish this every day at 9 automatically": no automation card; the agent proposes a single post or explains that automations are for still designs.
6. Dismiss a card: it shows Dismissed. Reload the page: every card keeps its state.
7. Not checkable without publishing: the Scheduled / Created state after the dialog saves, and the editor staying open after Create. Report them as not verified in the browser.
