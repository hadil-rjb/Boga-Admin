# Brand design system for the Studio Agent (phase 1) — design

Date: 2026-11-10 · Workspace: Social Media Admin (Studio) · Status: approach approved in chat, awaiting spec review

## Goal

The Studio Agent designs posts that look like the brand made them. Each brand gets a **design system**: a
stored, structured description of how the brand designs (type scale, colour roles, spacing, layout patterns,
logo placement, shapes, imagery, do and don't rules). Claude writes it once by studying the brand's own work;
the user can read and correct it; the agent follows it on every run and checks its result against it.

Today the agent receives the brand's name, voice, dos and don'ts, colour names and hex values, font names,
logo names and template names (`context()` in `frontend/studio/engine.js`). It never sees a layout, a picture
of the brand's work, or any rule about size, spacing or placement.

Success:

- On a brand with three or more templates, **Analyze** produces a design system in the Brand kit that a
  designer would recognise as that brand: the right headline size range, the real margins, the logo corner,
  the layouts the templates use.
- From the Overview prompt box, "an announcement post for our new feature" on two different brands gives two
  designs that differ the way the brands differ, each using its own fonts, colour pairs, margins and one of
  its own layout patterns.
- The agent's finished slide passes the design check (no off-palette colour, no font outside the brand's, no
  text in the margins, readable contrast), or the agent says which rule it broke on purpose and why.
- A brand with no design system behaves exactly as today.

### Phases

This spec covers **phase 1** only. Each later phase gets its own spec.

| Phase | Sources the system learns from | Status |
| --- | --- | --- |
| 1 | Brand templates and past designs (already in the app) | this spec |
| 2 | Uploaded inspiration images (new Brand kit section) | later |
| 3 | Brand guide PDF (extend the existing guide import) | later |

Phase 1 fixes the data shape, the analysis call, the Brand kit tab and the agent's use of the system, so
phases 2 and 3 only add sources.

### Decisions taken

| Question | Decision |
| --- | --- |
| Approach | A design system **distilled once and stored**, not raw material sent on every run |
| Where it lives | `designSystem` on the brand document (`social_brands` is `strict: false`, so no migration) |
| Who renders pictures | The studio, with the existing `renderSlide`, as the brand guide import does. The server never renders |
| When it is analysed | Only when the user presses **Analyze** or **Re-analyze**. No automatic runs (each one costs a Claude call) |
| User edits | The user can edit every value. User-written rules survive a re-analysis; other values are replaced after a confirmation |
| Model | Claude through the workspace's Anthropic key, same model and call style as `brand-guide/guide.ts`. Groq is not used for analysis (no reliable vision) |
| Agent without a system | Unchanged behaviour |
| Units | Sizes and distances are stored for a **1080 px wide canvas**; the agent and the check scale them by `canvasWidth / 1080` |

## The design system

```js
brand.designSystem = {
  v: 1,
  at: 1794330000000,            // when it was analysed
  model: 'claude-opus-5-5',
  sig: 't3a:1794…|d9k:1794…',   // the sources and their last change, to tell when it is stale
  sources: [{ kind: 'template' | 'design', id, name, ratio }],
  summary: 'Two or three sentences: the overall look.',
  type: [                        // one entry per role the brand uses
    { role: 'headline' | 'subhead' | 'body' | 'label' | 'caption',
      font, weight, sizeMin, sizeMax, lh, ls, upper: false, align: 'left' | 'center' | 'right' },
  ],
  colors: {
    roles: [{ hex, role: 'background' | 'surface' | 'text' | 'accent' | 'muted', usage: 'short note' }],
    pairs: [{ bg, text, accent }],          // combinations the brand really uses
    gradients: ['linear-gradient(…)'],      // only if the brand uses them
  },
  layout: {
    margin: 72, gap: 24,                    // px at 1080 wide
    align: 'left' | 'center' | 'mixed',
    logo: { corner: 'tl' | 'tr' | 'bl' | 'br' | 'none', width: 140 },
    patterns: [                             // the brand's recurring compositions
      { id, name: 'Dark hero with pill', when: 'Announcements', ratio: '4:5', sourceId,
        slots: [{ role: 'headline' | 'subhead' | 'body' | 'label' | 'logo' | 'image' | 'cta' | 'shape',
                  x, y, w, h }] },          // 0..1 of the canvas
    ],
  },
  shapes: { radius: 24, stroke: 0, shadow: 'none' | 'soft' | 'hard', motifs: 'short note' },
  imagery: 'short note: photos, illustration, none; treatment',
  rules: [{ text: 'Never centre body text', kind: 'do' | 'dont', by: 'ai' | 'user' }],
};
```

Limits, enforced on the server after the model answers and again in the studio when the user edits: at most
5 type roles, 8 colour roles, 6 pairs, 3 gradients, 8 patterns with at most 10 slots each, 16 rules; every
hex is a valid six-digit code; every number is clamped to a sane range; every slot lies inside the canvas;
every `sourceId` is one of the references that were sent. A value that fails is dropped, not guessed.

The whole object, serialised for the agent, stays under about 6,000 characters.

## Analysis

### Choosing the references (studio, pure function)

`pickSources(brand, designs, posts)` returns at most **12** references:

1. Every brand template, newest first.
2. Then the brand's designs that are **Approved** or have a **published post**, newest first.
3. First page only. Live-data pages (calendar, price, news) are included, flagged `live`, so the model reads
   their style but not their changing text.
4. Drafts are never used.

With no reference at all, the tab explains that the brand needs at least one template or approved design and
offers the existing "Save page as brand template".

### The call

`POST /api/social/brands/:brandId/design-system/analyze` (roles: admin, editor).

Request, built by the studio:

- `kit`: name, industry, voice, colours, fonts, logo names (what the agent already gets).
- `references`: for each one `{ kind, id, name, ratio, w, h, live, image, layers }`. `image` is a JPEG data
  URL rendered by `renderSlide`, long side at most 1000 px. `layers` is the compact layer list the agent
  already uses (`compact()`), so the model can read exact sizes, fonts and positions instead of guessing them
  from pixels.

Server (`backend/src/social/design-system/system.ts`), modelled on `brand-guide/guide.ts`:

- Validates the DTO (count, sizes, data URL pattern).
- Sends the pictures and layer lists to Claude with a zod output format matching the shape above, and a
  system prompt that says: describe what the references **do**, do not invent a style; measure from the
  layer lists; normalise sizes to a 1080 px wide canvas; name a pattern only when a reference shows it.
- Runs `tidy()` to enforce the limits, then returns `{ system, model }`.
- Tracks usage as "Design system" in the AI usage page.

The studio stores the result on the brand with `sig`, `at` and `sources`, through the existing brand
persistence. Nothing is stored server-side by the endpoint itself.

### Errors

| Case | What the user sees |
| --- | --- |
| No Claude key | The tab shows "Add a Claude key in Settings → AI" with the existing set-up button |
| Claude rejects the key, times out or refuses | A toast with the reason; the previous system, if any, is kept untouched |
| The answer fails validation entirely | Same as above: "Claude's answer could not be used, try again" |
| A reference cannot be rendered | It is skipped; the analysis runs on the others if at least one remains |

## Brand kit: the Design system tab

A new tab in the Brand kit, after Templates.

- **Empty:** what the design system is, what it will be built from (the list from `pickSources`, as small
  thumbnails), and one **Analyze** button. While it runs: a progress line ("Claude is studying 7 designs…").
- **Filled:** read top to bottom as a style sheet.
  - Summary (editable text).
  - Type: one row per role, set in its own font and weight, with the size range, editable.
  - Colours: role chips, and the pairs drawn as small swatches (background with its text and accent).
  - Layout: margin, gap, alignment, logo corner and width, editable.
  - Patterns: one wireframe card per pattern, drawn from its slots, with its name, "when to use", and the
    reference it came from. Rename or delete; no drawing editor in phase 1.
  - Rules: do and don't lists. Add, edit, delete. A rule the user writes or changes becomes `by: 'user'`.
  - Footer: "Analysed 3 days ago from 7 designs" and **Re-analyze**.
- **Stale:** when `sig` no longer matches the current references, a notice says the templates or designs
  changed and offers Re-analyze.
- **Re-analyze:** a confirmation says edited values will be replaced and the user's own rules will be kept.
- View-only users see the system but none of the editing controls.

## The agent

### Context

`context()` adds `brand.designSystem` (the stored object without `sig`, `at`, `model`) and
`brand.references`: `[{ id, kind, name, ratio }]` from the system's `sources`. The templates list stays.

### Prompt

`AGENT_PROMPT` (`backend/src/ai/agent.ts`) gains a section used only when the context has a design system:

- Follow the design system. It is how this brand designs; the brand kit's colours and fonts are the
  ingredients, the design system is the recipe.
- Sizes and distances are for a 1080 px wide canvas: multiply by `width / 1080`.
- For a new design, choose the layout pattern whose "when" fits the request and build its slots; adapt the
  slots to the canvas ratio. If none fits, compose from the type scale, margins and colour pairs.
- Use only the listed colour pairs for text on backgrounds.
- Look at a reference (`view_reference`) when unsure how the brand handles something.
- Before finishing, call `check_design` and fix what it reports. If you keep a violation on purpose, say so.
- The user's request wins over the system when they conflict; say what you departed from.

### New tools

| Tool | Runs | Does |
| --- | --- | --- |
| `view_reference { id }` | studio | Returns a picture and the compact layer list of that template or design's first page. Models without vision get the layers only |
| `check_design { page? }` | studio | Runs `lintSlide` on the slide and returns the violations as text, or "No issues" |

`apply_brand_template` stays as it is.

### The design check (`lintSlide`, pure function)

`lintSlide(page, canvas, brand, system)` returns a list of `{ layerId, rule, detail }`:

- **Font:** a text layer whose family is not one of the brand's fonts or the system's type fonts.
- **Size:** a text layer smaller than the smallest `sizeMin` or larger than the largest `sizeMax`, scaled.
- **Colour:** a text colour or solid fill whose colour difference (CIE76 ΔE in Lab) is above 12 from every
  brand colour and system colour. Black and white are always allowed.
- **Margin:** a visible text layer whose box crosses the system margin, scaled.
- **Contrast:** text against the layer directly under it, or the page background, below 4.5:1 (3:1 for text
  of 28 px or more at 1080 wide). Skipped when the layer under it is a picture or a gradient.
- **Logo:** the system names a corner and the slide has no logo layer.

Locked background layers, hidden layers and live-data texts are ignored. With no design system, the check
runs the font, colour and contrast rules against the brand kit only.

The same check is not shown to the user in phase 1; it serves the agent.

## Code layout

| File | Role |
| --- | --- |
| `frontend/studio/design-system.js` | Pure: `pickSources`, `sourceSig`, `tidySystem` (limits on user edits), `forAgent` (compact form), `lintSlide`, `patternWire` (slots → wireframe markup), `mergeRules` |
| `frontend/studio/design-system.test.js` | Unit tests for all of the above |
| `frontend/studio/engine.js` | The Brand kit tab, the analyze flow, `context()`, the two agent tools and their step labels |
| `frontend/styles/studio.css` | The tab's styles (`.ds-*`) |
| `backend/src/social/design-system/system.ts` | Zod schema, system prompt, the Claude call, `tidy` |
| `backend/src/social/design-system/system.controller.ts` | The endpoint and its DTO |
| `backend/src/social/design-system/system.test.ts` | `tidy` and DTO limits |
| `backend/src/ai/agent.ts` | The two tool definitions and the prompt section |
| `backend/src/social/social.module.ts` | Registers the controller |

`design-system.js` has no DOM and no engine imports, like `home.js`, so it is testable on its own.

## Testing

- **Unit (frontend):** source choice and order, the 12 cap, drafts excluded; the signature changes when a
  template is edited; `tidySystem` drops bad hex codes, clamps numbers, cuts lists; each `lintSlide` rule
  with a passing and a failing slide, scaling on a 1920 px canvas, ignored layers; `mergeRules` keeps the
  user's rules.
- **Unit (backend):** `tidy` on a malformed model answer; DTO limits; the prompt section appears only when
  the context has a system.
- **In the browser, with a working Claude key:** analyse a brand with templates, read the tab, edit a rule,
  re-analyse and see the rule kept; run the same prompt on two brands and compare; watch the agent call
  `check_design` and fix a violation.

The saved Claude key is currently rejected by Anthropic, so the browser checks that need Claude cannot run
until the key is replaced in Settings → AI.

## Out of scope

- Uploaded inspiration and the brand guide PDF as sources (phases 2 and 3).
- Automatic analysis when templates change.
- A visual editor for layout patterns.
- Showing the design check to the user in the editor.
- Separate systems per platform or per format, and motion or video styling.
- Changing how templates are stored or applied.
