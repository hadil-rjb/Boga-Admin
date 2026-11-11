# Design System Phases 2 and 3 (Inspiration, Brand Guide) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brand's design system can also learn from uploaded inspiration pictures (composition and mood only) and from what the brand's guide says about design (its statements outrank the references).

**Architecture:** The pure module `frontend/studio/design-system.js` gains source gathering over three kinds, pattern origin, guide rules and their ordering. The analysis endpoint accepts pictures and a guide reading; the brand guide read returns a `design` object. `engine.js` adds a Sources section to the Design system tab with upload, add-guide and remove flows.

**Tech Stack:** Vanilla JS studio (ES modules, vitest), NestJS + class-validator + zod + `@anthropic-ai/sdk` (vitest).

**Spec:** `docs/superpowers/specs/2026-11-11-design-system-inspiration-and-guide-design.md` (builds on `docs/superpowers/specs/2026-11-10-brand-design-system-design.md`)

## Global Constraints

- Inspiration: at most **8** pictures per brand; long side at most **1400 px**, JPEG quality 0.8; PNG, JPEG, WebP only.
- Inspiration may influence layout patterns, imagery and the summary only. Never type, colour roles, pairs, gradients or logo placement.
- At most **3** patterns with `origin: 'inspiration'`; such a pattern's `sourceId` must be one of the pictures sent, else the pattern is dropped.
- Guide reading is text only: `layout`, `imagery`, `logoUse`, `typography` (each at most 400 characters), `rules` (at most 12, each at most 160 characters, kind `do` or `dont`). The PDF and its pages are never stored.
- The guide's statements outrank the references. Which rules are guide rules is decided by the studio (text match), never by the model: the server returns every rule as `by: 'ai'`.
- Adding a guide to an existing brand writes only `brand.guideDesign`; the brand kit is untouched.
- Analysis runs only on a user press; uploads never start one. Claude only.
- The whole analysis request stays under **20 MB** of image data.
- A brand with no inspiration and no guide behaves exactly as after phase 1, including an unchanged stale signature.
- User-facing copy: sentence case, no emoji, no em dashes, American spelling in the tab ("Colors", "Analyze").
- `frontend/studio/design-system.js` imports nothing from `engine.js` and touches no DOM.
- The two tidy functions (studio `tidySystem`, server `tidy`) must agree; `backend/src/social/design-system/tidy.fixture.json` is asserted by both test suites.
- The working tree has unrelated uncommitted work. Commit only clean files, staging exactly the paths named. `frontend/studio/engine.js`, `frontend/styles/studio.css`, `backend/src/social/social.module.ts`, `frontend/studio/home.js` are edited but never staged.
- Frontend tests: `cd frontend && npx vitest run <file>`. Backend tests: `cd backend && npx vitest run <path>` and `npx tsc --noEmit -p tsconfig.json`. Never `npm test` in backend.

## Review Focus

1. **A brand with only inspiration pictures and no design of its own.** Analyze must be offered and the request must be accepted with zero references (Task 1 `hasSources` test, Task 2 DTO test, Task 3 flow).
2. **The model marks a brand pattern as inspiration, or invents a fourth inspiration pattern.** The stored system keeps at most 3, each tied to a picture that was sent (Tasks 1 and 2 tests, shared fixture).
3. **A guide that says nothing about design.** Nothing is stored, the user is told, and the system is not marked stale (Task 1 `tidyGuideDesign` test, Task 3 flow).
4. **Re-analysis after the guide was removed.** Old guide rules must not survive as guide rules (Task 1 `mergeRules` test).
5. **A brand that uses neither feature.** Its signature, context and request are byte-identical to phase 1 (Task 1 `gatheredSig` test, Task 2 DTO test with no new fields).

---

### Task 1: Sources, limits and rules in the pure module

**Files:**
- Modify: `frontend/studio/design-system.js`
- Test: `frontend/studio/design-system.test.js`

**Interfaces:**
- Consumes (already in the file): `pickSources`, `sourceSig`, `sourceRev`, `tidySystem(raw, sourceIds?)`, `mergeRules(oldRules, newRules)`, `forAgent`, `agentExtras`, `LIMITS`.
- Produces:
  - `MAX_INSPIRATION = 8`, `MAX_INSPIRATION_PATTERNS = 3`.
  - `tidyGuideDesign(raw) -> { name, at, layout, imagery, logoUse, typography, rules } | null`. Strings trimmed; `name` at most 120; the four texts at most 400; `rules` at most 12 of `{ text (at most 160, non-empty), kind: 'do' | 'dont' }` (unknown kind → `'do'`); `at` a finite number or 0. Returns `null` when `raw` is not an object, or when all four texts are empty and there is no rule.
  - `guideForRequest(guideDesign) -> { name, layout, imagery, logoUse, typography, rules } | undefined` (tidied, without `at`; `undefined` when `tidyGuideDesign` gives `null`).
  - `gatherSources(brand, designs, posts) -> { own, inspiration, guide }`: `own = pickSources(...)`; `inspiration` = the first 8 of `brand.inspiration` that have a string `src`, as `{ kind: 'inspiration', id, name, ratio: w + 'x' + h, w, h, at, rev }` with `rev` a hash of `src` (same FNV-1a as `sourceRev`, exported as `hashText(s)`); `guide` = `{ name, rev }` with `rev = hashText(JSON.stringify(guideForRequest(brand.guideDesign)))`, or `null`.
  - `hasSources(g) -> boolean`: any own reference, inspiration picture or guide.
  - `gatheredSig(g) -> string`: `[sourceSig(g.own), g.inspiration.length ? 'i=' + sourceSig(g.inspiration) : '', g.guide ? 'g=' + g.guide.rev : ''].filter(Boolean).join('#')`. With no inspiration and no guide it equals `sourceSig(g.own)` exactly.
  - `tidySystem(raw, sourceIds?, inspirationIds?)`, added rules: each pattern gets `origin: 'brand' | 'inspiration'` (anything else → `'brand'`); for an `'inspiration'` pattern the `sourceId` is checked against `inspirationIds` when that array is given, and the pattern is **dropped** if it is not in it (a brand pattern keeps today's behaviour: unknown `sourceId` becomes `''` when `sourceIds` is given); after that, only the first 3 inspiration patterns are kept; rule `by` accepts `'ai' | 'user' | 'guide'`; a top-level `guide: { name }` (name at most 120) passes through when present, like `sources`.
  - `markGuideRules(rules, guideDesign) -> rules`: a copy where a rule whose trimmed, lower-cased text equals a guide rule's gets `by: 'guide'`, unless it is `by: 'user'`; with no guide, any `by: 'guide'` becomes `'ai'`.
  - `mergeRules(oldRules, newRules)`, new order: old rules with `by === 'user'`; then new rules with `by === 'guide'`; then the other new rules; no two rules with the same trimmed lower-cased text; cut to `LIMITS.rules`. Old rules with `by: 'guide'` or `'ai'` are never carried over.
  - `forAgent` keeps `by` on rules and `origin` on patterns, and drops `guide` with the other bookkeeping. `agentExtras` needs no change: inspiration sources stored in `system.sources` already flow into `references` with `kind: 'inspiration'`.

- [ ] **Step 1: Write the failing tests** (append to `design-system.test.js`; extend the existing import)

```js
import { MAX_INSPIRATION, MAX_INSPIRATION_PATTERNS, tidyGuideDesign, guideForRequest, gatherSources, hasSources, gatheredSig, markGuideRules, hashText } from './design-system.js';

const gd = () => ({ name: ' Guide 2026.pdf ', at: 5, layout: ' 12-column grid, 64 px margins ', imagery: '', logoUse: 'Clear space equals the height of the B', typography: '', rules: [{ text: ' Never stretch the logo ', kind: 'dont' }, { text: '', kind: 'do' }, { text: 'Use one accent per slide', kind: 'maybe' }] });
const pic = (id, src = 'data:image/jpeg;base64,AAA' + id) => ({ id, name: 'Pic ' + id, src, w: 1080, h: 1350, at: 1 });

describe('tidyGuideDesign', () => {
  it('trims, cuts and drops empty rules; null when the guide says nothing about design', () => {
    const g = tidyGuideDesign(gd());
    expect(g).toMatchObject({ name: 'Guide 2026.pdf', at: 5, layout: '12-column grid, 64 px margins', imagery: '', typography: '' });
    expect(g.rules).toEqual([{ text: 'Never stretch the logo', kind: 'dont' }, { text: 'Use one accent per slide', kind: 'do' }]);
    expect(tidyGuideDesign({ name: 'x.pdf', layout: ' ', imagery: '', logoUse: '', typography: '', rules: [] })).toBeNull();
    expect(tidyGuideDesign(null)).toBeNull();
    expect(tidyGuideDesign({ layout: 'x'.repeat(900) }).layout).toHaveLength(400);
    expect(tidyGuideDesign({ layout: 'a', rules: Array.from({ length: 30 }, (_, i) => ({ text: 'R' + i, kind: 'do' })) }).rules).toHaveLength(12);
  });
  it('guideForRequest drops the date and is undefined without a usable guide', () => {
    expect(guideForRequest(gd())).not.toHaveProperty('at');
    expect(guideForRequest(gd()).name).toBe('Guide 2026.pdf');
    expect(guideForRequest(undefined)).toBeUndefined();
  });
});
describe('gatherSources', () => {
  it('keeps own references, lists up to 8 pictures and the guide', () => {
    const brand = { templates: [{ id: 't1', name: 'T', ratio: '4:5', bg: '#000', layers: [] }], inspiration: Array.from({ length: 11 }, (_, i) => pic('i' + i)).concat([{ id: 'bad', name: 'no src' }]), guideDesign: gd() };
    const g = gatherSources(brand, [], []);
    expect(g.own.map((s) => s.id)).toEqual(['t1']);
    expect(g.inspiration).toHaveLength(MAX_INSPIRATION);
    expect(g.inspiration[0]).toMatchObject({ kind: 'inspiration', id: 'i0', name: 'Pic i0', ratio: '1080x1350', w: 1080, h: 1350 });
    expect(g.guide).toEqual({ name: 'Guide 2026.pdf', rev: expect.any(String) });
    expect(hasSources(g)).toBe(true);
  });
  it('a brand with only pictures, or only a guide, has sources; a brand with nothing has none', () => {
    expect(hasSources(gatherSources({ inspiration: [pic('i1')] }, [], []))).toBe(true);
    expect(hasSources(gatherSources({ guideDesign: gd() }, [], []))).toBe(true);
    expect(hasSources(gatherSources({}, [], []))).toBe(false);
    expect(gatherSources({ guideDesign: { layout: '' } }, [], []).guide).toBeNull();
  });
});
describe('gatheredSig', () => {
  const own = { templates: [{ id: 't1', name: 'T', ratio: '4:5', bg: '#000', layers: [] }] };
  it('equals the phase 1 signature when the brand has no pictures and no guide', () => {
    const g = gatherSources(own, [], []);
    expect(gatheredSig(g)).toBe(sourceSig(g.own));
  });
  it('changes when a picture is added, replaced or removed, and when the guide changes or goes', () => {
    const sig = (b) => gatheredSig(gatherSources({ ...own, ...b }, [], []));
    const base = sig({ inspiration: [pic('i1')], guideDesign: gd() });
    expect(sig({ inspiration: [pic('i1'), pic('i2')], guideDesign: gd() })).not.toBe(base);
    expect(sig({ inspiration: [pic('i1', 'data:image/jpeg;base64,ZZZ')], guideDesign: gd() })).not.toBe(base);
    expect(sig({ inspiration: [], guideDesign: gd() })).not.toBe(base);
    expect(sig({ inspiration: [pic('i1')], guideDesign: { ...gd(), layout: 'Other' } })).not.toBe(base);
    expect(sig({ inspiration: [pic('i1')] })).not.toBe(base);
    expect(sig({ inspiration: [pic('i1')], guideDesign: { ...gd(), at: 99 } })).toBe(base); // reading it again changes nothing
  });
});
describe('tidySystem with inspiration and guide', () => {
  const pat = (id, origin, sourceId) => ({ id, name: id, when: '', ratio: '4:5', origin, sourceId, slots: [{ role: 'headline', x: 0.1, y: 0.1, w: 0.8, h: 0.2 }] });
  const sys = (patterns, rules = []) => ({ type: [{ role: 'headline', font: 'Inter', weight: 700, sizeMin: 60, sizeMax: 90 }], layout: { patterns }, rules });
  it('keeps at most 3 inspiration patterns, each tied to a picture that was sent', () => {
    const s = tidySystem(sys([pat('a', 'brand', 't1'), pat('b', 'inspiration', 'i1'), pat('c', 'inspiration', 'gone'), pat('d', 'inspiration', 'i2'), pat('e', 'inspiration', 'i1'), pat('f', 'inspiration', 'i2'), pat('g', 'weird', 'nope')]), ['t1'], ['i1', 'i2']);
    expect(s.layout.patterns.map((p) => [p.id, p.origin, p.sourceId])).toEqual([['a', 'brand', 't1'], ['b', 'inspiration', 'i1'], ['d', 'inspiration', 'i2'], ['e', 'inspiration', 'i1'], ['g', 'brand', '']]);
    expect(s.layout.patterns.filter((p) => p.origin === 'inspiration')).toHaveLength(MAX_INSPIRATION_PATTERNS);
  });
  it('defaults origin to brand, accepts guide rules, and passes the guide name through', () => {
    const s = tidySystem({ ...sys([{ ...pat('a', undefined, 't1') }], [{ text: 'Never stretch the logo', kind: 'dont', by: 'guide' }, { text: 'X', kind: 'do', by: 'robot' }]), guide: { name: ' Guide.pdf ' } }, ['t1']);
    expect(s.layout.patterns[0].origin).toBe('brand');
    expect(s.rules.map((r) => r.by)).toEqual(['guide', 'ai']);
    expect(s.guide).toEqual({ name: 'Guide.pdf' });
    expect(forAgent(s)).not.toHaveProperty('guide');
    expect(forAgent(s).rules[0].by).toBe('guide');
  });
});
describe('guide rules', () => {
  const fresh = [{ text: 'never stretch the logo ', kind: 'dont', by: 'ai' }, { text: 'Logo top left', kind: 'do', by: 'ai' }];
  it('marks rules that match the guide, and unmarks them when there is no guide', () => {
    expect(markGuideRules(fresh, gd()).map((r) => r.by)).toEqual(['guide', 'ai']);
    expect(markGuideRules([{ text: 'Never stretch the logo', kind: 'dont', by: 'user' }], gd())[0].by).toBe('user');
    expect(markGuideRules([{ text: 'A', kind: 'do', by: 'guide' }], null)[0].by).toBe('ai');
    expect(fresh[0].by).toBe('ai'); // not mutated
  });
  it('orders user rules, then guide rules, then the rest, and never carries old guide rules over', () => {
    const old = [{ text: 'Mine', kind: 'do', by: 'user' }, { text: 'Old guide rule', kind: 'do', by: 'guide' }, { text: 'Old AI rule', kind: 'do', by: 'ai' }];
    const next = [{ text: 'Logo top left', kind: 'do', by: 'ai' }, { text: 'Never stretch the logo', kind: 'dont', by: 'guide' }, { text: 'mine', kind: 'do', by: 'ai' }];
    expect(mergeRules(old, next).map((r) => r.text)).toEqual(['Mine', 'Never stretch the logo', 'Logo top left']);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && npx vitest run studio/design-system.test.js`; expected: FAIL, the new exports are missing.
- [ ] **Step 3: Implement** everything in Interfaces. Export `hashText(s)` and make `sourceRev` use it. Keep every existing test passing; the existing `mergeRules` test must still hold.
- [ ] **Step 4: Run to verify it passes**, then the whole frontend suite: `npx vitest run`.
- [ ] **Step 5: Commit**

```bash
git add frontend/studio/design-system.js frontend/studio/design-system.test.js
git commit -m "Design system: inspiration pictures and the brand guide as sources (signature, pattern origin, guide rules)"
```

---

### Task 2: Server: pictures and the guide in the analysis, design reading in the guide import, agent prompt

**Files:**
- Modify: `backend/src/social/design-system/system.ts`, `system.controller.ts`, `system.test.ts`, `tidy.fixture.json`
- Modify: `backend/src/social/brand-guide/guide.ts`; Create: `backend/src/social/brand-guide/guide.test.ts`
- Modify: `backend/src/ai/agent.ts`, `backend/src/ai/agent.test.ts`
- Modify: `frontend/studio/design-system.test.js` (only the shared-fixture test, to pass the fixture's `inspirationIds`)

**Interfaces:**
- Consumes: the rules of Task 1's `tidySystem` (read it in `frontend/studio/design-system.js`; the server `tidy` must produce the same output on the fixture).
- Produces:
  - `AnalyzeSystemDto`: `references` becomes optional, 0 to 12; new `inspiration?: [{ id (same pattern, at most 80), name at most 120, w and h ints 100..8000, image data URL (png, jpeg, webp) at most 2_500_000 chars }]`, at most 8; new `guide?: { name at most 200, layout?, imagery?, logoUse?, typography? (strings at most 400), rules?: [{ text at most 160, kind: 'do' | 'dont' }] at most 12 }`.
  - Controller: when there is no reference, no inspiration picture and no guide with at least one non-empty text or rule, throw `BadRequestException("Add a template, an approved design, an inspiration picture or a brand guide first")`.
  - `tidy(raw, sourceIds, inspirationIds = [])`: pattern `origin` and the inspiration rules exactly as Task 1; rules stay `by: 'ai'` always (a model-sent `by` is ignored).
  - `systemFromAnswer(text, stopReason, sourceIds, inspirationIds = [])`.
  - `analyzeWithClaude` input gains `inspiration` and `guide`. Content order: references (as today), then each picture as a text block `Inspiration <id> · "<name>" · <w>×<h>` (name with control characters replaced by spaces, as for references) followed by its image, then, when a guide is given, a text block `Brand guide "<name>": the brand's own written rules.\n` + its JSON, then the kit block.
  - `SYSTEM_PROMPT` gains these instructions (tests match the quoted fragments): inspiration pictures are other brands' work, learn composition and mood from them, and "never take a colour, a font or a logo from them"; a pattern taken from one gets `origin` "inspiration" and that picture's id as `sourceId`, at most three such patterns, every other pattern is "brand"; the brand guide block is the brand's own written rules, "follow it even where the references differ" and add a rule saying so; copy its do and don't statements into `rules` first, shortened if needed; with no reference at all, take type and colours from the kit.
  - Zod schema: pattern gains `origin: z.enum(['brand', 'inspiration'])`.
  - `guide.ts`: `GuideSchema` gains `design: { layout, imagery, logoUse, typography: string, rules: [{ text, kind: 'do' | 'dont' }] }` with `.describe()` texts saying: only what the document states, `""` when it is silent. `SYSTEM` gains: "Design rules: report only what the document states or shows on a rules page; leave a field empty when the document is silent; do not turn general impressions into rules." New exported pure `tidyDesign(d) -> { layout, imagery, logoUse, typography, rules }` (trim, 400 / 160 / 12 limits, empty rule texts dropped, tolerant of a missing object), used by the existing `tidy`.
  - `agent.ts`, `DESIGN_SYSTEM_PROMPT` gains two lines: "- Inspiration references are other brands' work: borrow composition, never their colours, fonts, logo or words." and "- Rules marked guide come from the brand's own guide: never break them unless the user asks."
  - `tidy.fixture.json`: add top-level `"inspirationIds": ["i1"]`; in `raw.layout.patterns` add four patterns with `origin: "inspiration"` (two with `sourceId: "i1"`, one with an id that was not sent, and enough valid ones that the cap of 3 is exercised together with existing fixture patterns only if the total pattern cap of 8 still lets the test show it; if the 8-pattern cap interferes, reduce the fixture's other patterns) and one rule with `by: "guide"`; regenerate `expected` and check it by hand.

- [ ] **Step 1: Write the failing tests**

`system.test.ts` (add):

```ts
it('keeps at most three inspiration patterns tied to sent pictures, and never trusts a rule\'s by', () => {
  const pat = (id: string, origin: string, sourceId: string) => ({ id, name: id, when: '', ratio: '4:5', origin, sourceId, slots: [{ role: 'headline', x: 0.1, y: 0.1, w: 0.8, h: 0.2 }] });
  const g: any = good();
  g.layout.patterns = [pat('a', 'brand', 't1'), pat('b', 'inspiration', 'i1'), pat('c', 'inspiration', 'gone'), pat('d', 'inspiration', 'i1'), pat('e', 'inspiration', 'i1'), pat('f', 'inspiration', 'i1')];
  g.rules = [{ text: 'From the guide', kind: 'do', by: 'guide' }];
  const s = tidy(g, ['t1'], ['i1']);
  expect(s.layout.patterns.map((p: any) => [p.id, p.origin])).toEqual([['a', 'brand'], ['b', 'inspiration'], ['d', 'inspiration'], ['e', 'inspiration']]);
  expect(s.rules[0].by).toBe('ai');
  expect(tidy(good(), ['t1']).layout.patterns[0].origin).toBe('brand');
});
it('accepts pictures or a guide without references, and rejects a request with no source at all', async () => {
  const pic = { id: 'i1', name: 'P', w: 1080, h: 1350, image: 'data:image/jpeg;base64,AAAA' };
  expect(await check({ kit, inspiration: [pic] })).toBe(0);
  expect(await check({ kit, guide: { name: 'g.pdf', layout: '12 columns' } })).toBe(0);
  expect(await check({ kit, references: [ref()] })).toBe(0);
  expect(await check({ kit, inspiration: Array.from({ length: 9 }, (_, i) => ({ ...pic, id: 'i' + i })) })).toBeGreaterThan(0);
  expect(await check({ kit, guide: { name: 'g.pdf', layout: 'x'.repeat(401) } })).toBeGreaterThan(0);
  expect(await check({ kit, guide: { name: 'g.pdf', rules: [{ text: 'a', kind: 'maybe' }] } })).toBeGreaterThan(0);
});
it('the prompt keeps colours and fonts out of inspiration and puts the guide first', () => {
  expect(SYSTEM_PROMPT).toMatch(/never take a colour, a font or a logo from them/i);
  expect(SYSTEM_PROMPT).toMatch(/follow it even where the references differ/i);
  expect(SYSTEM_PROMPT).toMatch(/origin/);
});
```

Also export from the controller a pure `hasAnySource(dto: AnalyzeSystemDto): boolean` and test it: `false` for `{ kit }`, `false` for `{ kit, guide: { name: 'g.pdf', layout: ' ' } }`, `true` for a picture, a reference, or a guide with one rule. (`check`, `kit`, `ref`, `good` already exist in this test file; hoist `check`, `kit` and `ref` to file scope if they are local to a `describe`.)

`guide.test.ts` (new):

```ts
import { describe, expect, it } from 'vitest';
import { tidyDesign } from './guide';

describe('tidyDesign', () => {
  it('trims and cuts what the guide says about design, and tolerates a missing object', () => {
    const d = tidyDesign({ layout: '  12 columns ', imagery: 'x'.repeat(900), logoUse: '', typography: 'Headlines in caps', rules: [{ text: ' Never stretch the logo ', kind: 'dont' }, { text: '  ', kind: 'do' }, ...Array.from({ length: 20 }, (_, i) => ({ text: 'R' + i, kind: 'do' as const }))] });
    expect(d.layout).toBe('12 columns');
    expect(d.imagery).toHaveLength(400);
    expect(d.rules[0]).toEqual({ text: 'Never stretch the logo', kind: 'dont' });
    expect(d.rules).toHaveLength(12);
    expect(tidyDesign(undefined)).toEqual({ layout: '', imagery: '', logoUse: '', typography: '', rules: [] });
  });
});
```

`agent.test.ts` (add): `DESIGN_SYSTEM_PROMPT` matches `/borrow composition, never their colours, fonts, logo or words/` and `/Rules marked guide come from the brand's own guide/`.

`frontend/studio/design-system.test.js`: in the shared-fixture test pass `fixture.inspirationIds` as the third argument of `tidySystem`.

- [ ] **Step 2: Run to verify it fails** — `cd backend && npx vitest run src/social/design-system src/social/brand-guide src/ai`.
- [ ] **Step 3: Implement** the Interfaces. In `guide.ts` keep the Claude call untouched apart from the schema and the prompt line.
- [ ] **Step 4: Extend the fixture**, regenerate `expected` by running the server `tidy`, read it and check it against the rules by hand, and confirm the studio's `tidySystem` gives the same output (`cd frontend && npx vitest run studio/design-system.test.js`).
- [ ] **Step 5: Run to verify it passes** — the backend command above, `npx tsc --noEmit -p tsconfig.json`, and `cd frontend && npx vitest run`.
- [ ] **Step 6: Commit**

```bash
git add backend/src/social/design-system backend/src/social/brand-guide/guide.ts backend/src/social/brand-guide/guide.test.ts backend/src/ai/agent.ts backend/src/ai/agent.test.ts frontend/studio/design-system.test.js
git commit -m "Design system: the analysis reads inspiration pictures and the brand guide; the guide import reads its design rules"
```

---

### Task 3: The Sources section and its flows in the studio

**Files:**
- Modify: `frontend/studio/engine.js` (the Design system tab block: `dsView`, `ACT.dsAnalyze`, `dsRef`, `dsSources`, `dsPatternHTML`, `dsRulesHTML`; the agent tool `view_reference`; the "created from its brand guide" flow), `frontend/styles/studio.css`. Neither is staged or committed.

**Interfaces:**
- Consumes: Task 1's exports; `readBrandGuide(file, step) -> { guide, logos }` (existing: renders the PDF with pdf.js and calls `/social/brand-guide/read`; `guide.design` and `guide.isBrandGuide` come from Task 2); `readImage(file, max, cb(src, w, h))`; the endpoint of Task 2.
- Produces:
  - **Data:** `brand.inspiration` (array as in the spec), `brand.guideDesign` (always stored through `tidyGuideDesign`).
  - **Sources section** (`dsSourcesHTML(b, g, ro)`), shown at the top of the tab in the empty-with-sources and filled states, with three groups:
    - `Your designs`: the existing thumbnails, or the line `No templates or approved designs yet.`
    - `Inspiration`: one card per picture (thumbnail, an editable name `data-ds-insp="<id>"`, a remove button `data-act="dsInspDel" data-id`), the count `<n> of 8`, the button `Add pictures` (a `<label>` wrapping `<input type="file" id="dsInspUp" accept="image/png,image/jpeg,image/webp" multiple hidden>`), and the helper line `Other brands' work you like. Claude learns layout and mood from it, never colors, fonts or logos.`
    - `Brand guide`: without one, the button `Add your brand guide (PDF)` (`<input type="file" id="dsGuideUp" accept="application/pdf,.pdf" hidden>`), disabled with the existing key note when there is no Claude key; with one, `<name>`, `read <relative time>`, buttons `Replace` (same input) and `Remove` (`data-act="dsGuideDel"`); while reading, the progress line `Reading the brand guide…` in the tab's `aria-live` region.
  - **Empty state with no source at all:** title `Nothing to learn from yet`, text `Save a template, approve a design, add inspiration pictures or add your brand guide.`, followed by the Sources section so pictures and the guide can be added from there.
  - **Uploading pictures:** each accepted file goes through `readImage(file, 1400, …)` and is re-encoded as JPEG 0.8 when it is not already JPEG; `name` is the file name without extension, at most 40 characters; stops at 8 with the toast `Inspiration is full (8 pictures). Remove one to add another.`; a file of another type gives `Choose PNG, JPG or WebP pictures` and the others are still added; then `save()` and redraw. No analysis starts.
  - **Adding a guide:** `readBrandGuide(file, step)`; if `!guide.isBrandGuide` → toast `This does not look like a brand guide.`; `gd = tidyGuideDesign({ ...guide.design, name: file.name, at: Date.now() })`; if `gd` is `null` → toast `This document says nothing about layout, imagery or logo use.` and nothing is stored; else `b.guideDesign = gd`, `save()`, redraw, toast `Brand guide added`. The brand kit (colors, fonts, voice, logos) is not written. The brand is captured before the first `await`; a per-brand in-memory flag blocks a second read while one runs.
  - **New brand from a guide** (existing flow that ends with the toast `… created from its brand guide`): set `guideDesign` on the new brand from `tidyGuideDesign({ ...g.design, name: file.name, at: Date.now() })` when it is not `null`.
  - **Analysis:** `g = gatherSources(b, designs, S.posts)`; nothing to do unless `hasSources(g)`; the confirmation and progress count `own + inspiration` pictures (`Claude is studying <n> designs…` stays; with a guide append ` and the brand guide`); the body is `{ kit, references, inspiration, guide: guideForRequest(b.guideDesign) }` with `inspiration` items `{ id, name, w, h, image }`; **budget:** if the summed length of all `image` strings exceeds 20,000,000, re-encode the inspiration pictures at 75% of their size, repeating up to 4 times, then drop pictures from the end until it fits; `tidySystem(r.system, ids, inspIds)`; rules: `mergeRules(old && old.rules, markGuideRules(fresh.rules.map((x) => ({ ...x, by: 'ai' })), b.guideDesign))`; stored `sig: gatheredSig(g)`, `sources`: the own references sent plus the pictures sent (`{ kind, id, name, ratio }`), `guide: { name }` when a guide was sent.
  - **Stale:** `gatheredSig(gatherSources(...)) !== system.sig`.
  - **Filled state:** a pattern with `origin: 'inspiration'` shows the tag `Inspiration` and `From <picture name>`; a rule with `by: 'guide'` shows the tag `Guide`; editing a guide rule's text makes it `by: 'user'` (existing edit path).
  - **Agent tool `view_reference`:** for a source of kind `inspiration`, find the picture in `brand().inspiration`; return `{ text: 'Inspiration “<name>” (<w>×<h>): another brand's work. Use its composition only, with this brand's colours, fonts and logo.', image: <src> }` (re-encode smaller when `src` is longer than 2,500,000 characters); a picture that was removed since → `Error('No such reference')`.
  - CSS: classes prefixed `ds-src-` and `ds-tag`, token colours only, wraps at 375 px.

- [ ] **Step 1: Implement** the Interfaces. Read narrow ranges of `engine.js` only.
- [ ] **Step 2: Run the checks** — `cd frontend && node --check studio/engine.js && npm run -s check:css && npx vitest run`; expected: all pass.
- [ ] **Step 3: No commit** (both files hold unrelated uncommitted work). Report every edit with its line numbers.

---

### Task 4: Browser verification (controller)

Requires a working Claude key and the API restarted so it serves Task 2's code.

- [ ] On a brand with no template and no approved design: add two pictures; `Analyze` is offered; the request has `inspiration` and no `references`; the tab fills; patterns from pictures carry the `Inspiration` tag; colours and fonts are the kit's.
- [ ] Add a guide to an existing brand: the kit's colours and fonts are unchanged; the Sources row shows the file name; the out-of-date notice appears.
- [ ] A brand with no pictures and no guide: no out-of-date notice appears just because of this change, and the analyze request has no `inspiration` or `guide` key.
- [ ] Remove a picture: the notice appears.
- [ ] Report each step as passed, failed or not run, with the reason.
