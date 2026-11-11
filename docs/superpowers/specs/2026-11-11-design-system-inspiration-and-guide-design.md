# Brand design system, phases 2 and 3: inspiration and the brand guide — design

Date: 2026-11-11 · Workspace: Social Media Admin (Studio) · Status: scope approved in chat, awaiting spec review

Builds on phase 1 (`docs/superpowers/specs/2026-11-10-brand-design-system-design.md`), which is built: a
stored `brand.designSystem`, written by Claude from the brand's templates and approved designs, editable in
the Brand kit's Design system tab, followed and checked by the Studio Agent.

## Goal

A brand's design system can also learn from two more sources:

- **Inspiration (phase 2):** reference pictures the user uploads (competitor posts, moodboards, old
  campaigns). Claude studies them for composition and mood. They never change the brand's colours, fonts or
  logo.
- **The brand guide (phase 3):** the brand's own guide or company profile (PDF). Today its import reads
  colours, fonts, voice and logos. It will also read what the guide says about design: layout, imagery,
  logo use, and its do and don't rules. What the guide states outranks what the references show.

Both are optional. A brand with neither behaves exactly as it does after phase 1.

Success:

- A new brand with no templates yet, three inspiration pictures and a brand kit: **Analyze** is available and
  produces a system whose type and colours come from the kit and whose layout patterns come from the
  pictures, each pattern marked as inspiration.
- A brand created from a brand guide: its Design system tab already shows "Brand guide: <file name>" as a
  source, and the analysed system carries the guide's rules (for example a clear-space rule for the logo).
- An existing brand: adding a guide in the tab does not change the brand kit's colours, fonts, voice or
  logos.
- The agent, asked for a post, can look at an inspiration picture, and its result still passes the design
  check against the brand's own palette and fonts.

### Decisions taken

| Question | Decision |
| --- | --- |
| Where inspiration lives | `brand.inspiration`: up to **8** pictures, stored with the brand like its other assets |
| What inspiration may influence | Layout patterns, imagery and the summary. Never type, colour roles, pairs, gradients or logo placement |
| How it is marked | A pattern learned from a picture has `origin: 'inspiration'`; at most **3** of the 8 patterns may be |
| Where the guide's design reading lives | `brand.guideDesign`: text only. The PDF and its pages are not stored |
| Guide versus references | The guide's statements win. References fill in what the guide does not say |
| Guide for an existing brand | Added from the Design system tab. Only `guideDesign` is written; the brand kit is untouched |
| One guide per brand | Adding another replaces the stored reading |
| Analysis without designs | Allowed when the brand has at least one inspiration picture or a guide reading |
| When things run | Still only on a user press. Uploading a picture or a guide never starts an analysis by itself |
| Models | Claude only, same calls as today |

## Phase 2: inspiration

### Data

```js
brand.inspiration = [
  { id: 'i' + uid(), name: 'Competitor carousel', src: 'data:image/jpeg;base64,…', w: 1080, h: 1350, at: 1794400000000 },
];
```

- At most 8. Each picture is resized in the browser to a long side of at most **1080 px** and stored as JPEG
  (quality 0.72); PNG, JPEG and WebP are accepted, SVG is not. (Changed in review from 1400 px / 0.8: every
  brand save and the browser's local safety copy carry the pictures, so they are kept small. Hosting them as
  media files, as design pictures are, is the follow-up.)
- `name` comes from the file name, at most 40 characters, and is editable.
- Stored and synced with the brand, as `brand.assets` is. The server already keeps unknown brand keys.

### Sources and the stale signal

`pickSources` keeps its meaning (the brand's own work, at most 12). A new pure function gathers everything
an analysis reads:

```js
gatherSources(brand, designs, posts) -> {
  own: [...],          // pickSources(...)
  inspiration: [{ kind: 'inspiration', id, name, ratio: '1080x1350', rev }],   // rev: hash of src
  guide: { name, rev } | null,                                              // rev: hash of the guideDesign text
}
```

`sourceSig` covers all three, so adding, removing or replacing a picture or the guide marks the system out
of date. The stored `designSystem.sources` lists own references and inspiration pictures that were sent;
`designSystem.guide` records `{ name }` when a guide reading was used.

### Analysis

Request gains `inspiration: [{ id, name, w, h, image }]` (0 to 8) and the limit "at least one reference"
becomes "at least one of: a reference, an inspiration picture, a guide reading".

- Pictures are sent after the references, each under the header `Inspiration <id> · "<name>" · <w>×<h>`.
- The whole request stays under **20 MB**: if it would not, the studio re-encodes pictures smaller (the
  references first keep their size; inspiration pictures shrink first).
- The system prompt gains: inspiration pictures are other brands' work; learn composition and mood from
  them; never take a colour, a font or a logo from them; a pattern taken from one gets
  `origin: "inspiration"` and its `sourceId`; at most three such patterns; say in `imagery` what the
  pictures suggest only if the brand's own work is silent on imagery.

Shape change: `layout.patterns[].origin` is `'brand'` (default) or `'inspiration'`. Both tidy functions
enforce the enumeration, the maximum of 3, and that an `inspiration` pattern's `sourceId` is one of the
pictures sent (otherwise the pattern is dropped, since nothing vouches for it).

### The tab

A **Sources** section sits at the top of the Design system tab in every state that can analyse:

- **Your designs:** the thumbnails phase 1 already shows (read-only; they come from templates and approved
  designs).
- **Inspiration:** thumbnails with a remove button each, an **Add pictures** button (multiple files), and
  the count "3 of 8". Helper line: "Other brands' work you like. Claude learns layout and mood from it,
  never colours, fonts or logos."
- **Brand guide:** see phase 3.

Empty state copy when the brand has nothing at all: "Nothing to learn from yet. Save a template, approve a
design, add inspiration pictures or add your brand guide."

In the filled state, a pattern from inspiration shows a small "Inspiration" tag and "From <picture name>".

### The agent

- `brand.references` in the agent's context lists inspiration pictures too, with `kind: 'inspiration'`.
- `view_reference` serves them: the picture, and the text `Inspiration “<name>” (<w>×<h>): another brand's
  work. Use its composition only, with this brand's colours, fonts and logo.` No layer list exists for them.
- The prompt section gains one line: "Inspiration references are other brands' work: borrow composition,
  never their colours, fonts, logo or words."
- The design check is unchanged. It already enforces the brand's own palette and fonts.

## Phase 3: the brand guide

### What the guide read returns

`GuideSchema` (`backend/src/social/brand-guide/guide.ts`) gains one object:

```ts
design: {
  layout: string,    // what the guide says about grids, margins, alignment, composition ("" when silent), max 400
  imagery: string,   // photography or illustration style and treatment ("" when silent), max 400
  logoUse: string,   // clear space, minimum size, placement, backgrounds ("" when silent), max 400
  typography: string,// hierarchy, sizes or cases the guide prescribes beyond the font names ("" when silent), max 400
  rules: [{ text: string, kind: 'do' | 'dont' }],   // the guide's own do and don't statements about design, max 12, 160 chars each
}
```

The system prompt for the guide read adds: report only what the document states or shows on a rules page;
leave a field empty when the document is silent; do not turn general impressions into rules.

`tidy` in `guide.ts` trims the strings, drops empty rules and cuts the list.

### Storing it

```js
brand.guideDesign = { name: 'Brand guide 2026.pdf', at: 1794400000000, layout, imagery, logoUse, typography, rules };
```

- **New brand from a guide** (existing flow "Start from a brand guide"): the result is stored on the new
  brand. Nothing else in that flow changes.
- **Existing brand** (new): the Design system tab's Sources section has a **Brand guide** row.
  - Without one: "Add your brand guide (PDF)" button. It runs the same read (`readBrandGuide`'s PDF
    rendering and the same endpoint) with the same progress steps, then stores only `guideDesign`.
  - With one: the file name, "read 3 days ago", **Replace** and **Remove**.
  - If the reading comes back with every field empty: nothing is stored and the user is told "This document
    says nothing about layout, imagery or logo use."
- Removing the guide or replacing it marks the system out of date; it does not change the system by itself.

### Analysis

Request gains `guide: { name, layout, imagery, logoUse, typography, rules } | undefined`.

The system prompt gains: sources rank guide, then the brand's own references and kit, then inspiration; the
guide block is the brand's own written rules; where the references depart from it, follow the guide and
write the guide's version as a rule; the guide's do and don't statements are added to `rules` by the studio,
word for word, so the model does not repeat them; use the references and the kit for everything the guide
does not cover.

Which rules are guide rules is decided by the studio, not by the model: the server still returns every rule
as `by: 'ai'`. After an analysis the studio puts the guide's own rules first, word for word, as
`by: 'guide'` (changed in review: asking the model to copy them lost the tag whenever it reworded one), and
also marks a model rule `by: 'guide'` when its text matches a guide rule (case-insensitive, trimmed). The
studio's `tidySystem` accepts `by` as `'ai' | 'user' | 'guide'`.

Order of the stored rules after an analysis: the user's rules kept from before, then the fresh rules marked
guide, then the other fresh rules, without duplicates, cut to 16. Old guide rules are never carried over by
themselves: if the guide was removed, the next analysis has none.

In the tab, a guide rule shows a small "Guide" tag. Editing it makes it the user's (`by: 'user'`).

### The agent

No new tool. The guide's influence reaches the agent through the system it shaped. `forAgent` keeps `by`
on rules so the agent can see which rules are the brand's written ones, and the prompt section gains: "Rules
marked guide come from the brand's own guide: never break them unless the user asks."

## Errors

| Case | What the user sees |
| --- | --- |
| A picture is not PNG, JPEG or WebP, or cannot be read | "Choose PNG, JPG or WebP pictures"; the others are still added |
| Adding pictures beyond 8 | The first ones that fit are added; "Inspiration is full (8 pictures). Remove one to add another." |
| The PDF cannot be opened, or Claude cannot read it | The existing brand guide errors, unchanged |
| The document is not a brand guide (`isBrandGuide` false) | "This does not look like a brand guide." Nothing is stored |
| No Claude key | The existing set-up note; upload buttons for pictures still work (they need no key), the guide button does not |

## Compatibility

- A system stored before this change has no `origin` on patterns and no `'guide'` rules: both default
  correctly (`'brand'`, and existing `by` values stay).
- Its signature is unchanged for a brand with no pictures and no guide, so no out-of-date notice appears
  because of this change (improved in planning: the signature only gains parts when a brand has pictures or
  a guide).
- The server keeps `inspiration` and `guideDesign` like any other brand key. The phase 1 safeguard that keeps
  a stored `designSystem` when a save omits it is **not** extended to them: removing a picture or the guide
  must be able to delete it. A stale tab can therefore bring back a removed picture or drop a new one; this
  is the same last-write-wins behaviour the brand's other assets have today.

## Code layout

| File | Change |
| --- | --- |
| `frontend/studio/design-system.js` | `gatherSources`, signature over all three, `origin` and the 3-pattern cap in `tidySystem`, `by: 'guide'`, `mergeRules` order, `markGuideRules(rules, guide)`, `tidyGuideDesign(raw)`, `agentExtras` lists inspiration |
| `frontend/studio/design-system.test.js` | Tests for each of the above; the shared tidy fixture gains an inspiration pattern, a fourth inspiration pattern (dropped) and a guide rule |
| `frontend/studio/engine.js` | Sources section, picture upload and removal, guide add / replace / remove, request building with the 20 MB budget, `view_reference` for pictures, storing `guideDesign` in the new-brand flow |
| `frontend/styles/studio.css` | Sources section styles (`.ds-src-*`), tags |
| `backend/src/social/design-system/system.ts`, `system.controller.ts` | `inspiration` and `guide` in the DTO and prompt; `origin` and `by` in the schema and `tidy`; the "at least one source" rule |
| `backend/src/social/brand-guide/guide.ts` | `design` in the schema, prompt and `tidy` |
| `backend/src/ai/agent.ts` | Two prompt lines |
| Tests next to each backend file | DTO bounds, tidy, prompt lines |

## Testing

- **Unit:** every pure function above; DTO limits (9 pictures rejected, no source at all rejected, guide
  strings over the limit rejected); the two tidy functions on the extended shared fixture; guide `tidy`.
- **In the browser, with a working Claude key:**
  1. A brand with only pictures: Analyze works; patterns carry the Inspiration tag; colours and fonts are
     the kit's.
  2. Add a guide to an existing brand: the kit is unchanged; the Sources row shows it; the out-of-date notice
     appears; after Re-analyze the guide's rules lead the list with the Guide tag.
  3. Remove a picture: the notice appears; Re-analyze drops patterns that came from it.
  4. Ask the agent for a post: it may call `view_reference` on a picture; the design check passes with the
     brand's own colours and fonts.
  5. A brand with no pictures and no guide: the tab and the agent behave as after phase 1.

## Out of scope

- Storing the PDF or its page pictures; several guides per brand.
- Notes or tags on inspiration pictures; inspiration from a URL.
- Automatic analysis after an upload.
- Conflict detection between browser tabs for brand data.
- Showing the design check to the user in the editor.
