# Studio Agent, phase 2: reading the planner and proposing posts and automations

Date: 2026-11-12
Status: draft for review

## Goal

The Studio Agent can plan publishing. It reads what is already planned and proposes a scheduled post or an automation for the open design as a card in the chat. The user opens the card into the existing Schedule post or New automation dialog, filled in, and confirms there. The agent never publishes, schedules, changes or deletes anything itself.

Success: with any design open, the user asks "post this tomorrow at 9 on Instagram and LinkedIn" or "publish this every weekday at 8 with an AI caption", and gets a card that opens the right dialog with those values. The user presses Schedule or Create there; nothing is created before that.

## Where this sits

Phase 1 (spec 2026-11-12-agent-animate-design.md) gave the agent a tool set per mode (`design`, `animate`). This phase adds three tools tagged for both modes and a card on the agent's chat message. Phase 3 (uploaded videos) is unchanged by this.

Decided with the user: anything that publishes is proposed and happens only when the user confirms; the card's main button opens the existing dialog filled in, so every existing check applies.

Not in this phase: editing, skipping or deleting existing posts or automations; proposing "Publish now"; proposing for a design other than the open one; any change to how posts or automations are stored or published.

## What exists today

- `frontend/studio/engine.js`
  - `openSchedule(d, o)` (about line 4401): the Schedule post dialog. `o` takes `post` (edit an existing post), `date`, `time`. It keeps its state in `st` (`pf` set of networks, `cap`, `caps`, `date`, `time`, `link`, `fc`), runs `checks()` (caption limits, Instagram ratios, past time, clashes with other posts, video rules) and saves through its own `commit(kind)`.
  - The planner block (an IIFE starting about line 4082) holds `conn()` (connected networks), `bestTimes(nets, dateKey, n)`, `nextSlot(nets)` and `taken(...)`. They are not reachable from the agent's block.
  - `S.posts`: the brand's posts, `{ id, d (design id), date 'YYYY-MM-DD', time 'HH:mm', pf: [network keys], status: 'Draft' | 'Scheduled' | 'Published' | …, cap, auto? }`.
  - v26 block (about line 8325): automations. `load()` fills `AU.list` from `GET /social/brands/:b/automations`; `openAuto(a, preset)` opens the automation dialog; `preset` carries `{ t (name), build, cadence, caption }`.
  - `schedTz()`: the workspace time zone. `PLATFORMS`: network keys and names (`ig`, `li`, `x`, `fb`, `tt`, `tg`).
  - The agent's `write_caption` tool already stores a caption on the chat message (`msg.caption`) and the panel draws it as a card with Copy and Schedule.
- `backend/src/social/automations`: automations render designs on the server as still images; there is no video path.

## Tools

All three are tagged `["design", "animate"]`.

### `read_planner`

Parameters: `days` (number, default 14, at most 31).

Returns JSON text:

```json
{
  "timeZone": "Europe/Istanbul",
  "today": "2026-11-12",
  "now": "15:40",
  "connected": ["ig", "li", "x"],
  "openDesign": { "id": "dl82935q", "name": "Gold hits a record high", "kind": "still", "scheduled": ["2026-11-14 09:00"] },
  "posts": [{ "date": "2026-11-13", "time": "08:00", "networks": ["ig", "x"], "design": "CPI release", "status": "Scheduled", "automation": false }],
  "automations": [{ "name": "Daily calendar", "design": "Economic calendar", "active": true, "cadence": "weekdays at 08:00", "networks": ["ig", "tg"] }],
  "bestTimes": { "2026-11-13": ["12:30", "17:30", "20:00"] },
  "nextFreeSlot": { "date": "2026-11-13", "time": "12:30" }
}
```

- `posts`: posts with `status` other than `Draft`, from today to `today + days`, sorted by date and time, at most 60. Design names come from the brand's designs; a missing design shows as "(deleted design)".
- `automations`: from `AU.list`; when the list is not loaded yet, the tool loads it first (`load()`); when that fails, `automations` is `[]` and the result adds `"automationsError": "<message>"`.
- `bestTimes`: for the next 7 days, for the connected networks, three times each (`bestTimes`).
- `nextFreeSlot`: `nextSlot(connected)`.
- Read only. It changes nothing.

### `propose_schedule`

Parameters: `networks` (array of network keys, required), `date` ('YYYY-MM-DD'), `time` ('HH:mm'), `caption` (string, at most 3000 characters), `firstComment` (string, at most 1000).

- `date` and `time` are in the workspace time zone. When both are missing, the next free slot is used. When one is missing, the error asks for it.
- Errors, returned to the model, nothing shown to the user:
  - an unknown network key; a network that is not connected (the error lists the connected ones);
  - a date or time that is not well formed; a moment in the past in the workspace time zone;
  - an uploaded video with no clip yet (`videoBlocked(d)`).
- On success the chat message gets `msg.proposal = { kind: 'post', d: <design id>, networks, date, time, caption, firstComment }` and the result is "A post card is shown: <date> at <time> on <networks>. The user opens it to review and schedule. Nothing is scheduled yet."
- One card per message: a second call in the same message replaces the first.

### `propose_automation`

Parameters: `name` (string, at most 80, default the design's name), `cadence` (`daily`, `weekdays`, `weekly`; required), `days` (array of 1–7, Monday = 1; required for `weekly`, ignored otherwise), `time` ('HH:mm', required), `networks` (required), `captionMode` (`fixed` or `ai`, default `fixed`), `caption` (string, at most 3000; for `fixed` the text, for `ai` an optional brief), `startDate`, `endDate` ('YYYY-MM-DD', optional).

- Errors: as for `propose_schedule` for networks; `weekly` with no days; a malformed time or date; `endDate` before `startDate`; and "Automations publish still designs only" when the open design is animated or an uploaded video.
- `captionMode: 'ai'` when no AI caption provider is ready turns into `fixed` with a note in the result, as the automation dialog does.
- The caption may use the automation fields the dialog lists (`{date}`, `{weekday}`, `{week}`, `{headline}`, `{price}`, `{website}`, `{hashtags}`). The tool description names them.
- On success: `msg.proposal = { kind: 'automation', d, name, cadence: { kind, days, time }, networks, caption: { mode, text }, startDate, endDate }` and the result says the card is shown and nothing is created yet.

## The card

Drawn in the agent's message, after its text, in the place and style of today's caption card (`.ag-cap`). One card per message.

Post card:

- Title "Post", the design's name.
- Lines: "Tomorrow, 09:00" (the planner's own date label and the time zone's short name), the networks as their icons and names, the caption clipped to three lines.
- Buttons: **Review and schedule** (primary), **Dismiss**.

Automation card:

- Title "Automation", its name.
- Lines: the rhythm in words ("Weekdays at 08:00", "Every Monday and Thursday at 09:00", "Every day at 18:00"), the networks, "AI caption" or the caption clipped to three lines, and the start and end dates when given.
- Buttons: **Review automation** (primary), **Dismiss**.

Behaviour:

- **Review** opens the dialog with the proposal's values. The proposal stays on the card, so the user can open it again after closing the dialog.
- After the user schedules or creates from that dialog, the card shows "Scheduled" or "Created" and its buttons are replaced by **Open planner** or **Open automations**.
- **Dismiss** marks the card dismissed: it shows one line, "Dismissed", and no buttons.
- When the open design changed since the proposal (another design is open), Review opens the dialog on the proposal's design, as the planner does when you open a post of another design.
- A card adds no Undo step and does not change the design.
- The proposal is saved with the chat (`d.chat`, as the caption is), so it survives a reload.

## Dialogs: starting from a proposal

- `openSchedule(d, o)` gains `o.prefill = { pf, cap, fc, date, time }`. Each given value replaces the dialog's default for a new post (networks, caption, first comment opened when given, date, time). `o.prefill` is ignored when `o.post` is given. `o.onDone(kind)` is called after the dialog saves (`schedule`, `draft`), so the card can show its result.
- `openAuto(a, preset)` gains a third parameter `prefill = { name, d, cadence, pf, caption, startDate, endDate, onDone }` for a new automation. Each given value replaces the default; `d` selects the design. `onDone()` is called after the automation is created.
- No other behaviour of either dialog changes.

## Prompt

Added to the agent's prompt in both modes:

- You cannot publish or schedule. To plan a post or an automation, propose it with propose_schedule or propose_automation; the user reviews and confirms it in the dialog. Never say that something is scheduled or created.
- When the user gives no time, call read_planner and use a best time that does not clash with another post on the same network (an hour apart at least), or nextFreeSlot.
- Times are in the planner's time zone. Say the day and time back in words.
- Propose only networks that are connected.
- Automations are for still designs. For a video, propose a single post.
- Write captions in the brand's voice and language, with the brand's hashtags, as write_caption does.

## Architecture

### Backend

- `backend/src/ai/agent.ts`: the three tools (above parameters, with `enum`s for network keys `ig`, `li`, `x`, `fb`, `tt`, `tg` and cadence kinds), tagged for both modes; `PLAN_PROMPT` with the lines above, added by `agentSystemPrompt` in both modes when the context says what the design is (the same condition as the `make_video` hint), so a studio tab opened before this change gets today's prompt.
- Tests in `backend/src/ai/agent.test.ts`: both modes include the three tools (design 22, animate 22); the plan section appears in both modes for a studio that sends `design.kind`, never for one that does not; the descriptions name the caption fields and say nothing is published.

### Frontend

- `frontend/studio/agent-plan.js` (new, pure, no DOM), unit-tested in `agent-plan.test.js`:
  - `checkSchedule(input, { connected, now: { date, time }, videoBlocked }) → { value, error }`
  - `checkAutomation(input, { connected, kind, aiReady, designName }) → { value, error, note }`
  - `plannerView({ posts, designs, automations, connected, today, now, days, openDesignId, bestTimes, nextFreeSlot, tz }) → object` (the `read_planner` JSON, before stringify)
  - `cadenceWords({ kind, days, time }) → string`
  - Time comparison uses the date and time strings in the workspace time zone (`nowIn(tz)` gives today's), so it needs no `Date` in the zone.
- `frontend/studio/engine.js`
  - Planner block: exposes `PLAN = { conn, bestTimes, nextSlot }` (module-level `let PLAN = null`, set in the block), as `AGAPI` is set by the agent block.
  - v26 block: exposes `AUTOS = { list: () => mine(), load, open: openAuto }`.
  - `openSchedule` and `openAuto`: `prefill` and `onDone` as above.
  - Agent block: the three tools in `T` with `STEP` labels "Reading the planner", "Proposing a post", "Proposing an automation"; `agMsg` draws the card from `m.proposal`; actions `agPlanOpen`, `agPlanDismiss`, `agPlanGo` (Open planner / Open automations).
- `frontend/styles/studio.css`: the card's lines and the network chips, reusing the caption card's classes where they fit.

## Errors and edge cases

- No network connected: both propose tools fail with "No network is connected. Connect one in Settings → Connected accounts." and the agent says so.
- A view-only user (`canEdit()` false) cannot send to the agent today, so no card is made for them. A card made by an editor and seen later by a viewer shows its lines with no Review button.
- The automations list cannot load: `read_planner` still answers with posts and says automations could not be read.
- The design is deleted after the proposal: Review shows a toast "This design was deleted" and the card shows "Design deleted" with no buttons.
- Time zone changes after the proposal: the card keeps the proposed date and time; the dialog shows its own time zone line.
- The proposed time passes before the user opens the card: the dialog's own check ("This time is in the past") stops it, with its date and time fields there to fix it.
- A proposal on an uploaded video that needs a clip: refused by the tool (`videoBlocked`); the dialog also blocks it.

## Testing

- `agent-plan.test.js`: every error of both checks; the default to `nextFreeSlot`; `weekly` days sorted and de-duplicated; `ai` turned into `fixed` with a note when AI is not ready; video kinds refused for automations; `plannerView` filters drafts, keeps the window, sorts, caps at 60, names deleted designs, and lists `scheduled` times of the open design; `cadenceWords` for each kind.
- `agent.test.ts`: as above.
- By hand, with an AI key: "post this tomorrow at 9 on Instagram" → card → Review opens the dialog with those values → Schedule → the card says Scheduled and the post is in the planner; "what's planned this week?" answers from `read_planner`; "publish this every weekday at 8 with an AI caption" → automation card → Review → Create → it appears on the Automations page; asking for an automation on an animated design gets a single-post proposal instead; Dismiss; reload keeps the card.
