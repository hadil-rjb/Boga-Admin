# Brand Design System (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each brand gets a stored design system, written by Claude from the brand's templates and approved designs, editable in the Brand kit, and followed and checked by the Studio Agent.

**Architecture:** A pure module `frontend/studio/design-system.js` owns source choice, limits, the agent's compact form and the design check. A new backend endpoint asks Claude for the system from pictures and layer lists the studio renders. `engine.js` adds a Brand kit tab, puts the system in the agent's context and runs two new agent tools; `agent.ts` declares the tools and the prompt section.

**Tech Stack:** Vanilla JS studio (ES modules, vitest), NestJS + class-validator + zod + `@anthropic-ai/sdk` (vitest), MongoDB brand documents (`strict: false`).

**Spec:** `docs/superpowers/specs/2026-11-10-brand-design-system-design.md`

## Global Constraints

- The system is stored as `brand.designSystem` on the brand object the studio already persists. No new collection, no schema change.
- Sizes and distances are stored for a **1080 px wide canvas**; consumers scale by `canvasWidth / 1080`.
- Limits: 5 type roles, 8 colour roles, 6 pairs, 3 gradients, 8 patterns, 10 slots per pattern, 16 rules. A value that fails validation is dropped, never guessed.
- At most **12** references per analysis; first page only; drafts never used.
- Analysis runs only on a user press. Claude only (Anthropic key), never Groq.
- A brand with no `designSystem` behaves exactly as before: same context, same prompt, same tools' results.
- User-facing copy: sentence case, no emoji, no em dashes (the repo's existing UI copy style).
- `frontend/studio/design-system.js` imports nothing from `engine.js` and touches no DOM.
- The working tree has unrelated uncommitted work. Every commit step stages only the files it names.
- Frontend tests: `cd frontend && npx vitest run <file>`. Backend tests: `cd backend && npx vitest run <file>`. CSS: `cd frontend && npm run -s check:css`.

## Review Focus

1. **A brand with zero templates and zero approved designs.** Analyze must be unavailable with an explanation, never send an empty request (Task 1 test, Task 7 check).
2. **A model answer with garbage in it** (bad hex, slot outside the canvas, `sourceId` that was not sent, 40 rules). The stored system must contain only valid values (Task 5 test).
3. **A canvas that is not 1080 wide** (1920×1080, 1280×720). The check must scale sizes and margins, not flag every layer (Task 3 test).
4. **Re-analysis after the user wrote their own rules.** The user's rules must survive, AI rules must be replaced (Task 2 test).
5. **A reference that fails to render** (missing picture, CORS). The analysis must continue with the others, and stop cleanly when none is left (Task 7 step).

---

### Task 1: Choosing the references

**Files:**
- Create: `frontend/studio/design-system.js`
- Test: `frontend/studio/design-system.test.js`

**Interfaces:**
- Produces:
  - `MAX_SOURCES = 12`
  - `pickSources(brand, designs, posts) -> Array<{ kind: 'template' | 'design', id: string, name: string, ratio: string, at: number, live: boolean }>`.
    `brand.templates` items are `{ id, name, ratio, bg, layers, live?, at? }`; `designs` items are `{ id, name, ratio, status, at, pages: [{ bg, layers, live? }] }`; `posts` items are `{ d: designId, status }`.
  - `sourceSig(sources) -> string`: `sources.map(s => s.id + ':' + (s.at || 0)).join('|')`.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { pickSources, sourceSig, MAX_SOURCES } from './design-system.js';

const tpl = (id, at) => ({ id, name: 'T ' + id, ratio: '4:5', bg: '#000', layers: [], at });
const des = (id, status, at) => ({ id, name: 'D ' + id, ratio: '1:1', status, at, pages: [{ bg: '#fff', layers: [] }] });

describe('pickSources', () => {
  it('takes templates first, newest first, then approved or published designs, never drafts', () => {
    const brand = { templates: [tpl('t1', 1), tpl('t2', 5)] };
    const designs = [des('d1', 'Draft', 9), des('d2', 'Approved', 3), des('d3', 'Scheduled', 8), des('d4', 'Draft', 7)];
    const posts = [{ d: 'd4', status: 'Published' }, { d: 'd3', status: 'Scheduled' }];
    expect(pickSources(brand, designs, posts).map((s) => s.id)).toEqual(['t2', 't1', 'd4', 'd2']);
  });
  it('caps at 12 and returns [] for a brand with nothing to learn from', () => {
    const brand = { templates: Array.from({ length: 20 }, (_, i) => tpl('t' + i, i)) };
    expect(pickSources(brand, [], [])).toHaveLength(MAX_SOURCES);
    expect(pickSources({ templates: [] }, [des('d1', 'Draft', 1)], [])).toEqual([]);
    expect(pickSources({}, undefined, undefined)).toEqual([]);
  });
  it('flags live pages and carries kind, name and ratio', () => {
    const s = pickSources({ templates: [{ ...tpl('t1', 1), live: { kind: 'calendar' } }] }, [], [])[0];
    expect(s).toMatchObject({ kind: 'template', id: 't1', name: 'T t1', ratio: '4:5', live: true });
  });
});
describe('sourceSig', () => {
  it('changes when a source is edited, added or removed', () => {
    const a = [{ id: 't1', at: 1 }, { id: 'd2', at: 3 }];
    expect(sourceSig(a)).toBe('t1:1|d2:3');
    expect(sourceSig([{ id: 't1', at: 2 }, { id: 'd2', at: 3 }])).not.toBe(sourceSig(a));
    expect(sourceSig([])).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run studio/design-system.test.js`
Expected: FAIL, cannot resolve `./design-system.js`.

- [ ] **Step 3: Implement `pickSources`, `sourceSig`, `MAX_SOURCES`** in `frontend/studio/design-system.js`. A design counts when `status === 'Approved'` or some post has `d === design.id && status === 'Published'`. A design's `live` is `!!pages[0].live`. Start the file with a header comment in the style of `home.js`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run studio/design-system.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/studio/design-system.js frontend/studio/design-system.test.js
git commit -m "Design system: choose the references a brand's system is learned from"
```

---

### Task 2: Limits, the agent's form, and keeping the user's rules

**Files:**
- Modify: `frontend/studio/design-system.js`
- Test: `frontend/studio/design-system.test.js`

**Interfaces:**
- Produces:
  - `LIMITS = { type: 5, roles: 8, pairs: 6, gradients: 3, patterns: 8, slots: 10, rules: 16 }`
  - `TYPE_ROLES = ['headline', 'subhead', 'body', 'label', 'caption']`, `COLOR_ROLES = ['background', 'surface', 'text', 'accent', 'muted']`, `SLOT_ROLES = ['headline', 'subhead', 'body', 'label', 'logo', 'image', 'cta', 'shape']`
  - `tidySystem(raw, sourceIds?: string[]) -> system | null`. Returns the spec's shape with every limit applied; `null` when `raw` is not an object. Rules: hex must match `/^#?[0-9a-f]{6}$/i` and is stored as upper-case `#RRGGBB`; type `sizeMin`/`sizeMax` clamped to 8..400 and swapped if reversed; `weight` 100..900; `lh` 0.8..3; `layout.margin` 0..300; `layout.gap` 0..200; `logo.width` 0..600; `shapes.radius` 0..300; slot `x, y, w, h` clamped to 0..1 with `x + w <= 1` and `y + h <= 1`, slots with `w` or `h` under 0.01 dropped; unknown roles dropped; a pattern with no slot left is dropped; when `sourceIds` is given, a pattern's `sourceId` not in it becomes `''`; strings trimmed (`summary` 600, `usage`/`when`/`motifs`/`imagery` 200, names 60, rule text 160); a rule's `kind` is `'do'` or `'dont'`, `by` is `'ai'` or `'user'`.
  - `mergeRules(oldRules, newRules) -> rules`: the old rules with `by === 'user'` first, then the new rules, without two rules of the same lower-cased text, cut to `LIMITS.rules`.
  - `forAgent(system) -> object | null`: the system without `v`, `at`, `model`, `sig`, `sources`; `null` for a missing system. `JSON.stringify(forAgent(tidySystem(big)))` stays under 6,000 characters for a system at every limit with maximum string lengths cut as above; if it is longer, drop patterns from the end until it fits.

- [ ] **Step 1: Write the failing tests**

```js
import { tidySystem, mergeRules, forAgent, LIMITS } from './design-system.js';

const base = () => ({
  summary: ' Bold and dark. ',
  type: [{ role: 'headline', font: 'Plus Jakarta Sans', weight: 700, sizeMin: 96, sizeMax: 72, lh: 1.05, ls: -1, upper: false, align: 'left' }, { role: 'nope', font: 'X', weight: 400, sizeMin: 10, sizeMax: 12 }],
  colors: { roles: [{ hex: 'e8343f', role: 'accent', usage: 'buttons' }, { hex: 'red', role: 'text', usage: '' }], pairs: [{ bg: '#0b1220', text: '#ffffff', accent: '#E8343F' }, { bg: 'zzz', text: '#fff' }], gradients: [] },
  layout: { margin: 9999, gap: 24, align: 'left', logo: { corner: 'tl', width: 140 }, patterns: [
    { id: 'p1', name: 'Hero', when: 'Announcements', ratio: '4:5', sourceId: 't1', slots: [{ role: 'headline', x: 0.1, y: 0.3, w: 1.4, h: 0.2 }, { role: 'ghost', x: 0, y: 0, w: 1, h: 1 }] },
    { id: 'p2', name: 'Empty', when: '', ratio: '1:1', sourceId: 'gone', slots: [{ role: 'body', x: 0.5, y: 0.5, w: 0.001, h: 0.2 }] }] },
  shapes: { radius: 24, stroke: 0, shadow: 'soft', motifs: 'pills' }, imagery: 'none',
  rules: Array.from({ length: 40 }, (_, i) => ({ text: 'Rule ' + i, kind: i % 2 ? 'do' : 'dont', by: 'ai' })),
});

describe('tidySystem', () => {
  it('keeps only valid values and applies every limit', () => {
    const s = tidySystem(base(), ['t1']);
    expect(s.summary).toBe('Bold and dark.');
    expect(s.type).toHaveLength(1);
    expect(s.type[0]).toMatchObject({ role: 'headline', sizeMin: 72, sizeMax: 96 });
    expect(s.colors.roles).toEqual([{ hex: '#E8343F', role: 'accent', usage: 'buttons' }]);
    expect(s.colors.pairs).toEqual([{ bg: '#0B1220', text: '#FFFFFF', accent: '#E8343F' }]);
    expect(s.layout.margin).toBe(300);
    expect(s.layout.patterns).toHaveLength(1);
    expect(s.layout.patterns[0].slots).toEqual([{ role: 'headline', x: 0.1, y: 0.3, w: 0.9, h: 0.2 }]);
    expect(s.rules).toHaveLength(LIMITS.rules);
  });
  it('returns null for something that is not a system, and survives missing sections', () => {
    expect(tidySystem(null)).toBeNull();
    expect(tidySystem('x')).toBeNull();
    const s = tidySystem({});
    expect(s).toMatchObject({ summary: '', type: [], colors: { roles: [], pairs: [], gradients: [] }, rules: [] });
    expect(s.layout.patterns).toEqual([]);
  });
});
describe('mergeRules', () => {
  it('keeps the user\'s rules, replaces the AI\'s, and drops duplicates', () => {
    const old = [{ text: 'Never centre body text', kind: 'dont', by: 'user' }, { text: 'Old AI rule', kind: 'do', by: 'ai' }];
    const fresh = [{ text: 'never centre body text', kind: 'dont', by: 'ai' }, { text: 'Logo top left', kind: 'do', by: 'ai' }];
    expect(mergeRules(old, fresh).map((r) => r.text)).toEqual(['Never centre body text', 'Logo top left']);
  });
});
describe('forAgent', () => {
  it('drops bookkeeping, stays under 6,000 characters, and is null without a system', () => {
    const s = { ...tidySystem(base(), ['t1']), v: 1, at: 5, model: 'm', sig: 'x', sources: [{ id: 't1' }] };
    const a = forAgent(s);
    expect(a).not.toHaveProperty('sig');
    expect(a).not.toHaveProperty('sources');
    expect(a.type).toHaveLength(1);
    expect(JSON.stringify(a).length).toBeLessThan(6000);
    expect(forAgent(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && npx vitest run studio/design-system.test.js`; expected: FAIL, `tidySystem` is not exported.
- [ ] **Step 3: Implement `LIMITS`, the role lists, `tidySystem`, `mergeRules`, `forAgent`** as specified in Interfaces.
- [ ] **Step 4: Run to verify it passes** — same command; expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/studio/design-system.js frontend/studio/design-system.test.js
git commit -m "Design system: limits, the agent's compact form, user rules survive re-analysis"
```

---

### Task 3: The design check

**Files:**
- Modify: `frontend/studio/design-system.js`
- Test: `frontend/studio/design-system.test.js`

**Interfaces:**
- Produces: `lintSlide(page, canvas, brand, system) -> Array<{ layerId: string, rule: 'font' | 'size' | 'colour' | 'margin' | 'contrast' | 'logo', detail: string }>`
  - `page`: `{ bg, layers }` with the editor's raw layers: `{ id, type: 'text' | 'rect' | 'ellipse' | 'line' | 'image', name, x, y, w, h, hidden?, locked?, feed?, font?, size?, color?, fill? }`. Layers are in paint order (later is on top).
  - `canvas`: `{ w, h }`. Scale `k = canvas.w / 1080`.
  - `brand`: `{ colors: [{ hex }], fonts: { heading, body, arabic } }`. `system`: a tidied system or `null`.
  - Ignored layers: `hidden`, `locked`, and any layer with `feed` (live data).
  - **font**: text layer whose `font` is not in the brand fonts or `system.type[].font` (case-insensitive).
  - **size** (needs `system.type.length`): `size < min(sizeMin) * k` or `size > max(sizeMax) * k`.
  - **colour**: a text `color`, or a `fill` that is a plain hex, whose CIE76 ΔE in Lab is above **12** from every brand colour and every `system.colors.roles[].hex`; `#000000` and `#FFFFFF` always pass. Fills that are gradients or `url(` are skipped.
  - **margin** (needs `system.layout.margin > 0`): a text layer with `x < m`, `y < m`, `x + w > canvas.w - m` or `y + h > canvas.h - m`, where `m = margin * k - 1`.
  - **contrast**: WCAG ratio of the text colour against the topmost earlier layer whose box contains the text's centre and whose `fill` is a plain hex, else `page.bg` when it is a plain hex; below **4.5**, or below **3** when `size / k >= 28`. Skipped when that layer's fill is a gradient or `url(`, or `page.bg` is not a plain hex.
  - **logo** (needs `system.layout.logo.corner` set and not `'none'`): no layer whose `name` matches `/logo/i`. Reported once with `layerId: ''`.
  - With `system === null`: only font, colour and contrast run, against the brand kit.
  - `detail` is one plain sentence naming the value and the allowed range, e.g. `Text is 20 px; the brand's smallest is 28 px.`
- Also produces: `lintText(issues, nameOf: (layerId) => string) -> string`: `'No issues.'` for an empty list, otherwise one line per issue, `- <layer name or "Slide">: <detail>`.

- [ ] **Step 1: Write the failing tests**

```js
import { lintSlide, lintText } from './design-system.js';

const brand = { colors: [{ hex: '#E8343F' }, { hex: '#0B1220' }, { hex: '#F8FAFC' }], fonts: { heading: 'Plus Jakarta Sans', body: 'Inter', arabic: 'Cairo' } };
const sys = tidySystem({
  type: [{ role: 'headline', font: 'Plus Jakarta Sans', weight: 700, sizeMin: 64, sizeMax: 110 }, { role: 'body', font: 'Inter', weight: 400, sizeMin: 28, sizeMax: 36 }],
  colors: { roles: [{ hex: '#94A3B8', role: 'muted', usage: '' }] },
  layout: { margin: 72, gap: 24, align: 'left', logo: { corner: 'tl', width: 140 }, patterns: [] },
});
const text = (o) => ({ id: 't', type: 'text', name: 'Headline', x: 80, y: 300, w: 800, h: 120, font: 'Plus Jakarta Sans', size: 80, color: '#FFFFFF', ...o });
const logo = { id: 'lg', type: 'image', name: 'Logo', x: 80, y: 80, w: 140, h: 40, fill: "url('x') center/contain no-repeat" };
const page = (...layers) => ({ bg: '#0B1220', layers: [logo, ...layers] });
const C = { w: 1080, h: 1350 };
const rules = (p, c = C, s = sys) => lintSlide(p, c, brand, s).map((i) => i.rule);

describe('lintSlide', () => {
  it('passes an on-brand slide', () => { expect(lintSlide(page(text()), C, brand, sys)).toEqual([]); });
  it('flags an off-brand font, a size outside the scale and an off-palette colour', () => {
    expect(rules(page(text({ font: 'Comic Sans MS' })))).toEqual(['font']);
    expect(rules(page(text({ size: 20 })))).toEqual(['size']);
    expect(rules(page(text({ size: 200 })))).toEqual(['size']);
    expect(rules(page(text({ color: '#22C55E' })))).toContain('colour');
    expect(rules(page(text({ color: '#E93540' })))).toEqual([]);          // within ΔE 12 of the brand red
    expect(rules(page(text({ color: '#94A3B8' })))).toEqual([]);          // a system colour
  });
  it('flags text in the margin and weak contrast, using the layer under the text', () => {
    expect(rules(page(text({ x: 20 })))).toEqual(['margin']);
    expect(rules(page(text({ color: '#0B1220' })))).toEqual(['contrast']);
    const card = { id: 'c', type: 'rect', name: 'Card', x: 72, y: 280, w: 900, h: 200, fill: '#F8FAFC' };
    expect(rules(page(card, text({ color: '#0B1220' })))).toEqual([]);
    expect(rules(page(card, text({ color: '#FFFFFF' })))).toEqual(['contrast']);
    const photo = { ...card, fill: "url('p.jpg') center/cover" };
    expect(rules(page(photo, text({ color: '#0B1220' })))).toEqual([]);   // unknown backdrop: skipped
  });
  it('scales sizes and margins on a canvas that is not 1080 wide', () => {
    const wide = { w: 1920, h: 1080 };
    expect(rules(page(text({ x: 128, y: 300, w: 1000, size: 140 })), wide)).toEqual([]);
    expect(rules(page(text({ x: 100, y: 300, w: 1000, size: 140 })), wide)).toEqual(['margin']);
    expect(rules(page(text({ x: 128, y: 300, w: 1000, size: 40 })), wide)).toEqual(['size']);
  });
  it('reports a missing logo once, and ignores hidden, locked and live layers', () => {
    const noLogo = { bg: '#0B1220', layers: [text()] };
    expect(lintSlide(noLogo, C, brand, sys)).toEqual([{ layerId: '', rule: 'logo', detail: expect.any(String) }]);
    expect(rules(page(text({ font: 'Arial', hidden: true }), text({ font: 'Arial', locked: true }), text({ font: 'Arial', feed: 'price' })))).toEqual([]);
  });
  it('without a system, checks font, colour and contrast against the brand kit only', () => {
    expect(rules({ bg: '#0B1220', layers: [text({ size: 12, x: 0 })] }, C, null)).toEqual([]);
    expect(rules({ bg: '#0B1220', layers: [text({ font: 'Arial' })] }, C, null)).toEqual(['font']);
  });
});
describe('lintText', () => {
  it('says so when there is nothing, and lists issues by layer name', () => {
    expect(lintText([], () => '')).toBe('No issues.');
    expect(lintText([{ layerId: 't', rule: 'size', detail: 'Too small.' }, { layerId: '', rule: 'logo', detail: 'No logo.' }], (id) => (id === 't' ? 'Headline' : ''))).toBe('- Headline: Too small.\n- Slide: No logo.');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — expected: FAIL, `lintSlide` is not exported.
- [ ] **Step 3: Implement `lintSlide` and `lintText`.** Private helpers in the same file: `rgbOf(hex)`, `labOf(rgb)` (sRGB → XYZ D65 → Lab), `deltaE(a, b)` (Euclidean in Lab), `luminance(rgb)` and `contrast(a, b)` (WCAG 2.1 formulas), `plainHex(v)` (returns `#RRGGBB` or `null`; accepts 3-digit hex).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit**

```bash
git add frontend/studio/design-system.js frontend/studio/design-system.test.js
git commit -m "Design system: the design check (font, size, colour, margin, contrast, logo)"
```

---

### Task 4: Server: Claude writes the system

**Files:**
- Create: `backend/src/social/design-system/system.ts`
- Create: `backend/src/social/design-system/system.controller.ts`
- Create: `backend/src/social/design-system/system.test.ts`
- Modify: `backend/src/social/social.module.ts` (import and add `DesignSystemController` to `controllers`, next to `BrandGuideController`)

**Interfaces:**
- Consumes: `AiService.anthropicKey()`, `trackClaude(label, model, usage)` from `backend/src/ai/usage`, the call style of `backend/src/social/brand-guide/guide.ts` (`client.beta.messages.stream` with `zodOutputFormat`, `GUIDE_MODEL`).
- Produces:
  - `POST /api/social/brands/:brandId/design-system/analyze`, roles admin and editor, HTTP 200.
  - Request body `AnalyzeSystemDto`: `kit: { name: string ≤120, industry?: string ≤200, voice?: string ≤2000, colors: [{ name ≤60, hex }] ≤12, fonts: { heading?, body?, arabic? } each ≤80 }`, `references: [{ kind: 'template' | 'design', id ≤80 matching /^[A-Za-z0-9_-]+$/, name ≤120, ratio ≤20, w: int 100..8000, h: int 100..8000, live?: boolean, image: data URL matching /^data:image\/(png|jpeg|webp);base64,/ ≤2_500_000 chars, layers: string ≤40_000 (JSON of the compact layer list) }]`, 1 to 12 items.
  - Response: `{ system, model }` where `system` has the spec's shape without `v`, `at`, `sig`, `sources`, `model`.
  - `export function tidy(raw: unknown, sourceIds: string[]): System` — the same rules as the studio's `tidySystem` (Task 2 Interfaces), plus every rule gets `by: 'ai'`. Throws `Error('empty')` when nothing usable is left (no type role and no pattern and no colour role).
  - `export const SYSTEM_PROMPT: string` — must contain these instructions: describe what the references do and do not invent a style; read sizes, fonts and positions from the layer lists, use the pictures for the overall look; convert every size and distance to a 1080 px wide canvas (`value * 1080 / reference width`); name a layout pattern only when a reference shows it and give its `sourceId`; slots are fractions of the canvas, 0 to 1; references flagged live show changing text, read their style only; rules are short, concrete and checkable.
- Errors: no key → `BadRequestException("Add a Claude key in Settings → AI to analyze a brand's designs")`; Claude failure, refusal or `tidy` throwing → `BadGatewayException("Claude couldn't analyze these designs: <reason>")`. Usage label: `"Design system"`.

- [ ] **Step 1: Write the failing tests** in `system.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { tidy, SYSTEM_PROMPT } from './system';
import { AnalyzeSystemDto } from './system.controller';

const good = () => ({
  summary: 'Bold and dark.',
  type: [{ role: 'headline', font: 'Inter', weight: 700, sizeMin: 72, sizeMax: 96, lh: 1.1, ls: 0, upper: false, align: 'left' }],
  colors: { roles: [{ hex: '#e8343f', role: 'accent', usage: 'buttons' }], pairs: [{ bg: '#0b1220', text: '#ffffff', accent: '#e8343f' }], gradients: [] },
  layout: { margin: 72, gap: 24, align: 'left', logo: { corner: 'tl', width: 140 }, patterns: [{ id: 'p1', name: 'Hero', when: 'Announcements', ratio: '4:5', sourceId: 't1', slots: [{ role: 'headline', x: 0.1, y: 0.3, w: 0.8, h: 0.2 }] }] },
  shapes: { radius: 24, stroke: 0, shadow: 'soft', motifs: '' }, imagery: 'none',
  rules: [{ text: 'Logo top left', kind: 'do' }],
});

describe('tidy', () => {
  it('normalises a good answer and marks rules as written by the AI', () => {
    const s = tidy(good(), ['t1']);
    expect(s.colors.roles[0].hex).toBe('#E8343F');
    expect(s.rules).toEqual([{ text: 'Logo top left', kind: 'do', by: 'ai' }]);
    expect(s.layout.patterns[0].sourceId).toBe('t1');
  });
  it('drops garbage: bad hex, slots outside the canvas, unknown sources, too many rules', () => {
    const g: any = good();
    g.colors.roles.push({ hex: 'blue', role: 'text', usage: '' });
    g.layout.patterns[0].slots.push({ role: 'body', x: 2, y: 2, w: 0.5, h: 0.5 });
    g.layout.patterns.push({ id: 'p2', name: 'Ghost', when: '', ratio: '1:1', sourceId: 'zzz', slots: [{ role: 'body', x: 0, y: 0, w: 0.5, h: 0.5 }] });
    g.rules = Array.from({ length: 40 }, (_, i) => ({ text: 'R' + i, kind: 'do' }));
    const s = tidy(g, ['t1']);
    expect(s.colors.roles).toHaveLength(1);
    expect(s.layout.patterns[0].slots).toHaveLength(1);
    expect(s.layout.patterns[1].sourceId).toBe('');
    expect(s.rules).toHaveLength(16);
  });
  it('refuses an answer with nothing usable', () => {
    expect(() => tidy({ summary: 'x' }, [])).toThrow('empty');
    expect(() => tidy(null, [])).toThrow('empty');
  });
});
describe('AnalyzeSystemDto', () => {
  const ref = (o = {}) => ({ kind: 'template', id: 't1', name: 'T', ratio: '4:5', w: 1080, h: 1350, image: 'data:image/jpeg;base64,AAAA', layers: '[]', ...o });
  const check = async (body: any) => (await validate(plainToInstance(AnalyzeSystemDto, body))).length;
  const kit = { name: 'Boga', colors: [{ name: 'Red', hex: '#E8343F' }], fonts: { heading: 'Inter' } };
  it('accepts 1 to 12 references and rejects 0, 13, a bad id and a non-image', async () => {
    expect(await check({ kit, references: [ref()] })).toBe(0);
    expect(await check({ kit, references: [] })).toBeGreaterThan(0);
    expect(await check({ kit, references: Array.from({ length: 13 }, (_, i) => ref({ id: 't' + i })) })).toBeGreaterThan(0);
    expect(await check({ kit, references: [ref({ id: '../x' })] })).toBeGreaterThan(0);
    expect(await check({ kit, references: [ref({ image: 'https://x/y.png' })] })).toBeGreaterThan(0);
  });
});
describe('SYSTEM_PROMPT', () => {
  it('tells the model to measure, to normalise to 1080 and not to invent', () => {
    expect(SYSTEM_PROMPT).toMatch(/1080/);
    expect(SYSTEM_PROMPT).toMatch(/do not invent/i);
    expect(SYSTEM_PROMPT).toMatch(/layer list/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && npx vitest run src/social/design-system/system.test.ts`; expected: FAIL, module not found.
- [ ] **Step 3: Implement `system.ts`**: the zod `SystemSchema` (the spec's shape; `rules` items are `{ text, kind }`), `SYSTEM_PROMPT`, `tidy`, and `analyzeWithClaude(apiKey: string, input: { kit, references }): Promise<{ system: System; model: string }>`. For each reference push a text block `Reference <id> · <kind> · "<name>" · <w>×<h>` (plus ` · live data` when flagged), the image block, then a text block with its `layers` cut to 40,000 characters; end with a text block holding the kit as JSON and `Write this brand's design system.` Same model, betas, thinking and `output_config` as `readGuideWithClaude`; `max_tokens: 16000`; client timeout 180 s.
- [ ] **Step 4: Implement `system.controller.ts`** (`@Controller("social/brands/:brandId/design-system")`, DTO classes with class-validator, the error mapping above) and register it in `social.module.ts`.
- [ ] **Step 5: Run to verify it passes** — same command; expected: PASS. Then `cd backend && npx tsc --noEmit -p tsconfig.json`; expected: no errors.
- [ ] **Step 6: Commit**

```bash
git add backend/src/social/design-system backend/src/social/social.module.ts
git commit -m "Design system: Claude writes a brand's system from its templates and designs"
```

---

### Task 5: The agent's prompt and tools (server side)

**Files:**
- Modify: `backend/src/ai/agent.ts` (`AGENT_TOOLS`, `AGENT_PROMPT`)
- Modify: `backend/src/ai/ai.service.ts` (`agentStep`, the line that builds `system`)
- Test: `backend/src/ai/agent.test.ts` (create)

**Interfaces:**
- Produces:
  - Two entries appended to `AGENT_TOOLS`:
    - `view_reference`: parameters `{ id: string }` required. Description: "Look at one of the brand's reference designs (ids in brand.references): a picture and its layers. Use it to see how the brand handles a layout before building your own."
    - `check_design`: parameters `{ page?: number }`. Description: "Check a slide against the brand's design system: off-brand fonts, colours and sizes, text in the margins, weak contrast, missing logo. Call it before you finish and fix what it reports."
  - `export const DESIGN_SYSTEM_PROMPT: string` — the seven instructions of the spec's "Prompt" section, as bullet lines under the heading line `The brand has a design system (brand.designSystem in the context):`.
  - `export function agentSystemPrompt(context: string): string` — `AGENT_PROMPT`, plus `"\n\n" + DESIGN_SYSTEM_PROMPT` only when `context` contains `"designSystem":{`.
  - `agentStep` builds `system` from `agentSystemPrompt(d.context)` instead of `AGENT_PROMPT`; the rest of the string is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { AGENT_PROMPT, AGENT_TOOLS, DESIGN_SYSTEM_PROMPT, agentSystemPrompt, cleanMessages } from './agent';

describe('agent design system', () => {
  it('declares view_reference and check_design', () => {
    const t = (n: string) => AGENT_TOOLS.find((x) => x.name === n)!;
    expect((t('view_reference').parameters as any).required).toEqual(['id']);
    expect(t('check_design')).toBeTruthy();
  });
  it('adds the design system section only when the context has a system', () => {
    const withSys = JSON.stringify({ brand: { name: 'B', designSystem: { summary: 'x' } } });
    const without = JSON.stringify({ brand: { name: 'B', designSystem: null } });
    expect(agentSystemPrompt(withSys)).toContain(DESIGN_SYSTEM_PROMPT);
    expect(agentSystemPrompt(without)).toBe(AGENT_PROMPT);
    expect(agentSystemPrompt('{}')).toBe(AGENT_PROMPT);
  });
  it('says how to scale, to pick a pattern, to check before finishing, and that the user wins', () => {
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/width \/ 1080/);
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/pattern/i);
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/check_design/);
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/user's request wins/i);
  });
  it('accepts calls to the new tools in a conversation', () => {
    const m = cleanMessages([{ role: 'user', text: 'hi' }, { role: 'assistant', calls: [{ id: 'a1', name: 'check_design', input: {} }, { id: 'a2', name: 'nope', input: {} }] }]);
    expect((m[1] as any).calls.map((c: any) => c.name)).toEqual(['check_design']);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && npx vitest run src/ai/agent.test.ts`; expected: FAIL, `DESIGN_SYSTEM_PROMPT` is not exported.
- [ ] **Step 3: Implement** the two tools, `DESIGN_SYSTEM_PROMPT`, `agentSystemPrompt`, and the one-line change in `agentStep`.
- [ ] **Step 4: Run to verify it passes**, then `cd backend && npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/agent.ts backend/src/ai/agent.test.ts backend/src/ai/ai.service.ts
git commit -m "Studio agent: follow the brand's design system, look at references, check the slide"
```

---

### Task 6: The agent's context and tools (studio side)

**Files:**
- Modify: `frontend/studio/engine.js` — the "v25 · Studio Agent with AI" block: `context()`, the tools object `T`, the step labels `STEP`; and the import line for `./design-system.js` near the other `./home.js` import.

**Interfaces:**
- Consumes: `forAgent`, `lintSlide`, `lintText` (Tasks 2 and 3); in the block: `compact(l)`, `slideOf`, `pageIx`, `curP()`, `dim()`, `brand()`, `getD(id)`, `renderSlide(design, pageIndex, scale, 'jpeg') -> Promise<Blob>`, `RATIOS`.
- Produces:
  - `context()`: `brand.designSystem = forAgent(b.designSystem)` and `brand.references = (b.designSystem && b.designSystem.sources || []).map(({ id, kind, name, ratio }) => ({ id, kind, name, ratio }))`. When the brand has no system, both keys are omitted, so the context string is byte-identical to today's.
  - `T.view_reference({ id })`: finds a brand template or a design with that id among the system's `sources`; throws `Error('No such reference')` otherwise. Returns `{ text, image }`: `text` is `Reference “<name>” (<kind>, <ratio>, <w>×<h>):\n` + `JSON.stringify(layers.map(compact))` cut to 12,000 characters; `image` is a JPEG data URL of the first page, long side at most 1000 px, or omitted when rendering fails. A template is rendered by passing `renderSlide` a one-page stand-in design `{ id: t.id, ratio: t.ratio, pages: [{ id: t.id, bg: t.bg, layers: t.layers }] }`.
  - `T.check_design({ page })`: `lintText(lintSlide(pg, { w, h }, brand(), brand().designSystem || null), (id) => (pg.layers.find((l) => l.id === id) || {}).name || '')`, prefixed with `Slide <n>: `.
  - `STEP.view_reference = () => 'Looking at a reference'`, `STEP.check_design = () => 'Checking the design'`.

- [ ] **Step 1: Implement the import, `context()`, the two tools and the two labels.**
- [ ] **Step 2: Verify nothing else changed** — `cd frontend && node --check studio/engine.js && npx vitest run`; expected: syntax OK, every test file passes.
- [ ] **Step 3: Verify in the browser** (preview server `web`, page `/social-media#/overview`): open any design, open the Agent tab, send "what fonts does this slide use?", then read the request with the network tool. Expected: the `POST /api/ai/agent` body's `context` has no `designSystem` key on a brand without a system. (With the current rejected Claude key the request returns 400; the request body is still the evidence.)
- [ ] **Step 4: Commit**

```bash
git add frontend/studio/engine.js
git commit -m "Studio agent: the design system in its context, view_reference and check_design"
```

---

### Task 7: The Brand kit tab and the analysis flow

**Files:**
- Modify: `frontend/studio/design-system.js` (add `patternWire`)
- Modify: `frontend/studio/design-system.test.js`
- Modify: `frontend/studio/engine.js` — `BKTABS` (add `['ds', 'Design system', 'wand']` after `tpl`), `BKP.ds`, new `ACT` entries, a delegated `change`/`input` listener for the tab's fields
- Modify: `frontend/styles/studio.css` (`.ds-*` rules, next to the Brand kit styles)

**Interfaces:**
- Consumes: `pickSources`, `sourceSig`, `tidySystem`, `mergeRules`, `LIMITS`, `TYPE_ROLES` (Tasks 1 and 2); `api(path, { method, body })`, `brand()`, `S.designs`, `S.posts`, `getD`, `renderSlide`, `compact` (expose it from the v25 block by adding it to the existing `AGAPI` object as `AGAPI.compact`), `thumb(page, ratio, w, h)`, `btThumb(template, w, h)`, `modal`, `toast`, `save()`, `route()`, `canEdit()`, `persist.readOnly`, `ACT.agModelSetup`, `AIS.view.ready` (true when an AI key is set).
- Produces:
  - `patternWire(pattern, { esc }) -> string`: an inline SVG, `viewBox="0 0 100 H"` with `H = 100 * ratioH / ratioW` parsed from `pattern.ratio` (`'4:5'` or `'1920x1080'`; unknown → 125), one `<rect>` per slot with `class="ds-slot ds-<role>"`, `rx="2"`, and a `<title>` with the role.
  - `ACT.dsAnalyze()`: the flow below. `ACT.dsRuleAdd`, `ACT.dsRuleDel` (`data-i`), `ACT.dsPatDel` (`data-id`), and field edits through `data-ds="<path>"` attributes (`summary`, `type.<i>.sizeMin`, `type.<i>.sizeMax`, `type.<i>.weight`, `layout.margin`, `layout.gap`, `layout.logo.corner`, `layout.logo.width`, `patterns.<i>.name`, `patterns.<i>.when`, `rules.<i>.text`). Every edit writes the value, sets an edited rule to `by: 'user'`, passes the whole system through `tidySystem`, stores it and calls `save()`.
  - Analysis flow: (1) `canEdit()`; (2) `src = pickSources(brand(), S.designs, S.posts)`, stop with the empty state if none; (3) if a system exists, confirm with a modal: title `Re-analyze this brand?`, text `The design system is rewritten from <n> designs. Values you edited are replaced. Rules you wrote are kept.`, buttons `Cancel` and `Re-analyze`; (4) show progress in the tab: `Claude is studying <n> designs…`; (5) render each source to a JPEG data URL, long side at most 1000 px, skipping any that throws; if none is left, toast `These designs could not be rendered. Open one and try again.` and stop; (6) `POST /social/brands/<id>/design-system/analyze` with `kit` and `references` (layers as `JSON.stringify(layers.map(AGAPI.compact))` cut to 40,000 characters); (7) on success store `{ ...tidySystem(r.system, ids), rules: mergeRules(old && old.rules, r.system.rules), v: 1, at: Date.now(), model: r.model, sig: sourceSig(src), sources: src.map(({ kind, id, name, ratio }) => ({ kind, id, name, ratio })) }` as `brand().designSystem`, `save()`, redraw, toast `Design system updated`; (8) on failure toast the server's message and leave the old system untouched. The brand is captured at step 1; if the active brand changed before the answer arrives, the result is still stored on the captured brand and the tab is not redrawn.
  - Tab states and copy:
    - No AI key: `Add a Claude key in Settings → AI to analyze this brand's designs.` with a `Set up AI` button (`data-act="agModelSetup"`).
    - No source: title `Nothing to learn from yet`, text `Save a page as a brand template, or approve a design, then come back.`
    - Empty with sources: title `Teach the agent how <brand> designs`, text `Claude studies these <n> designs and writes the brand's design system: type, colours, spacing, layouts and rules. You can edit everything afterwards.`, the sources as thumbnails, button `Analyze`.
    - Filled: sections `Summary`, `Type`, `Colours`, `Layout`, `Patterns`, `Rules`, in that order, then the footer `Analysed <relative time> from <n> designs` and `Re-analyze`.
    - Stale (`sourceSig(pickSources(...)) !== system.sig`): a notice above the sections, `Templates or designs changed since this was analysed.`, with `Re-analyze`.
    - View-only (`persist.readOnly`): fields render as text, no buttons.

- [ ] **Step 1: Write the failing test for `patternWire`**

```js
import { patternWire } from './design-system.js';

describe('patternWire', () => {
  const esc = (s) => String(s).replace(/</g, '&lt;');
  it('draws one rect per slot on a canvas with the pattern\'s shape', () => {
    const svg = patternWire({ ratio: '4:5', slots: [{ role: 'headline', x: 0.1, y: 0.3, w: 0.8, h: 0.2 }, { role: 'logo', x: 0.1, y: 0.06, w: 0.2, h: 0.05 }] }, { esc });
    expect(svg).toContain('viewBox="0 0 100 125"');
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg).toContain('class="ds-slot ds-headline"');
    expect(svg).toContain('x="10" y="37.5" width="80" height="25"');
  });
  it('reads pixel ratios and falls back to 4:5', () => {
    expect(patternWire({ ratio: '1920x1080', slots: [] }, { esc })).toContain('viewBox="0 0 100 56.25"');
    expect(patternWire({ ratio: '?', slots: [] }, { esc })).toContain('viewBox="0 0 100 125"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**, implement `patternWire`, run to verify it passes.
- [ ] **Step 3: Implement the tab** (`BKTABS`, `BKP.ds`, the actions, the field listener, `AGAPI.compact`) and its styles. Layout: one column of sections inside the existing `.widget`; type rows show the role name set in its own font and weight; colour pairs are 56×40 swatches with the text colour as "Aa" and the accent as a dot; patterns are a grid of cards (wireframe, name, when); rules are two lists (Do, Don't) with an inline text field per rule.
- [ ] **Step 4: Run the checks** — `cd frontend && node --check studio/engine.js && npm run -s check:css && npx vitest run`; expected: all pass.
- [ ] **Step 5: Verify in the browser** (preview `web`, `/social-media#/brand`, tab Design system):
  - On a brand with templates: the empty state lists the sources as thumbnails and shows `Analyze`.
  - On a brand with no template and no approved design: the "Nothing to learn from yet" state, no `Analyze` button.
  - Press `Analyze`: one `POST …/design-system/analyze` whose body has `references` with `image` and `layers`. With a working Claude key the tab fills; with the rejected key a toast shows the server's reason and the tab returns to the empty state.
  - The filled, stale and edit states need a stored system, which needs a working Claude key. Do not stub the endpoint to fake one; if no key works, report those states as unverified.
  - Phone width (375 px): no horizontal scroll; pattern cards wrap.
- [ ] **Step 6: Commit**

```bash
git add frontend/studio/design-system.js frontend/studio/design-system.test.js frontend/studio/engine.js frontend/styles/studio.css
git commit -m "Brand kit: Design system tab, analyze and edit a brand's design system"
```

---

### Task 8: End-to-end check with a working Claude key

**Files:** none (verification only). Requires a valid Anthropic key in Settings → AI; the key saved in this workspace on 2026-11-10 is rejected by Anthropic.

- [ ] **Step 1:** On a brand with three or more templates, press `Analyze`. Expected: the tab fills within about a minute; the headline size range, margin and logo corner match what the templates show; each pattern names a real source.
- [ ] **Step 2:** Add a rule by hand, press `Re-analyze`, confirm. Expected: the hand-written rule is still first in its list.
- [ ] **Step 3:** From the Overview prompt box, send `An announcement post for our new feature` on this brand. Expected in the Agent's work log: `Checking the design` appears before the final message; the slide uses the brand's fonts and one of its colour pairs.
- [ ] **Step 4:** Send the same prompt on a second brand that has its own system. Expected: a visibly different design (fonts, colours, layout).
- [ ] **Step 5:** Send the same prompt on a brand with no system. Expected: the agent behaves as before; the request's `context` has no `designSystem` key.
- [ ] **Step 6:** Report each step as passed, failed or not run, with the reason. Do not report the feature as verified if this task could not run.
