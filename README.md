# UX Boğa Admin

One admin for the Boğa team: **Blog Admin** (articles, editorial calendar, Search Console, AI, Framer)
and **Social Media Admin** (overview, planner, design studio, brand kits), behind a single sign-in.

| Layer    | Stack                                       | Folder      |
| -------- | ------------------------------------------- | ----------- |
| Frontend | Next.js 15 (App Router), React 19, Tailwind v4 | `frontend/` |
| Backend  | NestJS 10, Mongoose 8                       | `backend/`  |
| Database | MongoDB (one database for both workspaces)  | —           |

## Run it

Requirements: **Node 22+** (`nvm use`, see `.nvmrc`) and MongoDB (`docker compose up -d mongo` if you don't have one).

```bash
npm run install:all
```

```bash
npm install
```

```bash
npm run seed
```

```bash
npm run dev
```

- App: http://localhost:3000 (sign in, then switch workspaces from the menu at the top of the sidebar)
- API: http://localhost:4000/api

Configuration: `backend/.env` (see `backend/.env.example`: `MONGODB_URI`, `JWT_SECRET`, `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, Google / Framer keys, `BODY_LIMIT`) and `frontend/.env.local` (`NEXT_PUBLIC_API_URL`).
The admin account is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` on first start; invite teammates from
**Share**. Optional variables can be left empty (they fall back to their defaults).

Production: `npm run build` then `npm start`. Deployment notes for the Blog Admin (Vercel, Render, Google OAuth)
are in `backend/README.md`.

## One sign-in, two workspaces

- **Login** (`/login`) is the Blog Admin's JWT login. The token (`uxb.token`) is shared by both workspaces;
  opening `/social-media` without a session sends you to `/login?next=/social-media` and back.
- **Roles** come from the same users collection: `admin` and `editor` can change the social workspace,
  `viewer` can look around (nothing is saved, the studio says so), share links (`role: link`) have no access.
  Resetting the social demo data is admin-only.
- **Switching** uses the existing workspace menus: *Blog Admin* ↔ *Social Media Admin* (*Chatbot Admin* is
  still "coming soon"). The studio sidebar shows the signed-in user with *Profile* and *Sign out*.
- **Blog → social:** the Boğa brand's "From your blog" panel lists the latest live articles from the
  Blog Admin, ready to turn into posts ("Make post").
- The theme (dark / light, `uxb.t`) is shared.

## Frontend layout

```
frontend/
  app/
    layout.tsx                 the one root layout: fonts, theme + workspace boot script
    globals.css                the one stylesheet entry (layers, Tailwind, imports below)
    (blog)/(admin)/…           Blog Admin: dashboard, articles, calendar, search, settings, profile, bot
    (blog)/login/              sign-in (supports ?next=)
    (social)/social-media/     Social Media studio; /social-media/planner → /social-media#/planner
    not-found.tsx              404
  styles/
    tokens.css                 design tokens for both workspaces (colors per theme, brand, fonts)
    base.css                   shared foundation + per-workspace base rules
    studio.css                 studio component styles, scoped to the Social Media workspace
  postcss/scoped-import.cjs    build step: Tailwind's reset, scoped to the Blog Admin
  components/                  Blog Admin components · WorkspaceScope (sets <html data-ws>)
  components/social/StudioApp.tsx   studio shell: session, data, mounts/unmounts the engine
  lib/workspace.ts             workspace detection + boot script
  lib/api.ts                   API client (Bearer token)
  lib/social/persist.ts        studio load / autosave against /api/social
  studio/                      the studio engine, its runtime (mount/unmount), icons, templates
  scripts/check-css.mjs        `npm run check:css` after a build: guards against class-name clashes
```

## Styling: one system for both workspaces

Both workspaces share **one root layout, one stylesheet and one set of design tokens**, and switching between
them is a client-side navigation (no page reload).

- **Tokens** (`styles/tokens.css`): every color (dark and light), the brand accents, elevation and font
  stacks are defined once. Tailwind utilities (`bg-surface`, `text-text-2`, `border-border`, `bg-pill`,
  `text-accent`, `font-jakarta`, …) map to them, and the studio stylesheet uses the same variables.
- **Fonts**: one font set for everything, loaded in `app/layout.tsx`: Inter and Plus Jakarta Sans for the UI,
  plus the studio's post fonts.
- **Cascade layers** (`app/globals.css`), lowest to highest priority:
  `theme` → `base` (reset, shared foundation, per-workspace base) → `components` (studio) → `utilities`
  (Tailwind, usable in both workspaces) → `compat`.
- **Workspace scope**: `<html data-ws="blog|social">` is set before first paint and on every navigation
  (`components/WorkspaceScope.tsx`). Workspace-specific rules are wrapped in `:where([data-ws=…])`, which adds
  no specificity, so every rule keeps exactly the weight it had in its original stylesheet:
  - Tailwind's reset (preflight) applies to the Blog Admin only; the studio was designed on browser
    defaults. `postcss/scoped-import.cjs` inlines it from the installed Tailwind, scoped, via
    `@import "tailwindcss/preflight.css" layer(base.reset) scope([data-ws="blog"])`.
  - Studio component rules (`.btn`, `.card`, `.side`, …) apply in the Social Media workspace only, so they
    can never style a Blog Admin element.
- **Kept on purpose, to preserve the designs exactly**:
  - Each workspace keeps its own font *fallback* stack (`--blog-sans` vs `--sans`). It decides how glyphs
    that Inter doesn't have (✗, ❝, →) render, and the blog's metric-matched fallback faces are in `tokens.css`.
  - The blog's implicit bold (`b`, `strong`, `th`) renders at 600, as it always did. Before the merge only the
    400–600 Inter weights were loaded for the blog.
  - The blog's old global `* { min-width: 0 }` was unlayered, so it always overrode `min-w-*` utilities. It now
    lives in the `compat` layer, so blog layouts stay the same.
- **Known overlaps**: `.grid` and `.grow` are both Tailwind utilities and studio classes. The utilities only set
  what the studio's rules already set (`display: grid`, `flex-grow: 1`), so they're harmless.
  `npm run check:css` (after a build) fails if a new clash appears.

## Switching workspaces without a reload

The studio engine was written to own a whole page. It now mounts and unmounts with the `/social-media` route:
- `studio/runtime.js` records every listener, observer, timer and popup the engine adds to the page.
- On leave, `destroy()` removes all of them in the same render as the next page, and the workspace is saved.
- On return, the studio boots instantly from the in-memory workspace.
- Studio pages use the URL hash (`#/planner`, `#/editor/:id`). Those history entries are tied to the
  `/social-media` route, so Back/Forward between workspaces works.

The studio itself is the original Social Media Admin code, kept as one module (`studio/engine.js`) so its UI
stays pixel-identical. The comments at the top of that file list what was changed.

## Backend

The Blog Admin API, plus `src/social/`:

| Method | Path | Who |
| ------ | ---- | --- |
| GET | `/api/social/workspace` | signed in |
| PATCH | `/api/social/workspace` (incremental sync used by the studio) | admin, editor |
| PUT | `/api/social/workspace` (replace with a snapshot / JSON backup) | admin, editor |
| DELETE | `/api/social/workspace` (reset demo data) | admin |
| GET / PATCH | `/api/social/settings` | read: signed in · write: admin, editor |
| GET / POST | `/api/social/brands` | read: signed in · write: admin, editor |
| GET / PATCH / DELETE | `/api/social/brands/:brandId` | 〃 |
| GET / POST | `/api/social/brands/:brandId/designs` (`?q=`) | 〃 |
| GET / PATCH / DELETE | `/api/social/brands/:brandId/designs/:id` | 〃 |
| GET / POST | `/api/social/brands/:brandId/posts` (`?from=&to=&status=`) | 〃 |
| PATCH / DELETE | `/api/social/brands/:brandId/posts/:id` | 〃 |
| GET | `/api/social/brands/:brandId/connections` | connected accounts and setup state per network |
| GET | `/api/social/brands/:brandId/connections/:net/auth-url` | admin, editor · starts a network sign-in |
| POST / DELETE | `/api/social/brands/:brandId/connections/:net` | admin, editor · Telegram connect / disconnect |
| GET | `/api/social/connections/callback/:net` | public · the networks' OAuth redirect |
| PUT | `/api/social/brands/:brandId/posts/:id/media` | admin, editor · rendered slides of a scheduled post |
| POST | `/api/social/brands/:brandId/posts/:id/publish` | admin, editor · publish now |
| GET | `/api/social/brands/:brandId/publish-state` | publish results (the studio polls this) |
| GET | `/api/social/media/:id.jpg` | public · published images (Instagram and TikTok download them) |
| GET | `/api/social/figma/status` | connection, default file, recent files, teams |
| GET | `/api/social/figma/oauth/url` | admin, editor · Connect Figma: consent URL (state + PKCE) |
| GET | `/api/social/figma/oauth/callback` | public · Figma's redirect after consent (checked with `state`) |
| DELETE | `/api/social/figma/connection` | admin, editor · disconnect (tokens deleted) |
| PUT | `/api/social/figma/token` | admin, editor · connect with a personal access token instead of OAuth |
| PUT / DELETE | `/api/social/figma/default` · `DELETE /recent/:key` | admin, editor · default file · forget a recent file |
| POST / DELETE | `/api/social/figma/teams` · `/teams/:id` | admin, editor · teams shown in the file picker |
| GET | `/api/social/figma/teams/:id/folders` · `/folders/:id/files` | team folders · files and subfolders of a folder |
| GET | `/api/social/figma/frames?fileKey=&nodeId=` (or `?url=`) · `/version?fileKey=` | frames of a file · last change of a file |
| POST | `/api/social/figma/import` | admin, editor · frames → studio layers |

Social collections are prefixed: `social_brands`, `social_designs`, `social_posts`, `social_workspaces`.
The rest of the API (auth, articles, share, AI, Search Console, Framer, media) is unchanged; see
`backend/README.md`.

## Figma import

### Connect Figma (OAuth 2.0)

Settings → Figma → **Connect Figma** opens figma.com in a popup: the user signs in and clicks *Allow access*, Figma
sends them back, and the account shows as connected. Nothing to copy or paste.

- Set up once by an admin: create an app at [figma.com/developers/apps](https://www.figma.com/developers/apps),
  add the callback URL `<PUBLIC_API_URL>/social/figma/oauth/callback` and the scopes `current_user:read`,
  `file_content:read`, `file_metadata:read` (plus `folders:read` on a private app to browse teams), then set
  `FIGMA_CLIENT_ID` and `FIGMA_CLIENT_SECRET` in `backend/.env` (optional `FIGMA_SCOPES`). The settings page shows
  these steps and the exact callback URL when the app isn't configured.
- **"Invalid redirect uri" on figma.com** means the redirect URL sent isn't in the app's list. Settings → Figma
  shows the exact URL with a Copy button: in Figma, *My apps* → the app → *OAuth credentials* → *Add a redirect
  URL*, paste it as is (same scheme, port and path, no trailing slash). To register a different URL instead, set
  `FIGMA_REDIRECT_URI` (for example `<FRONTEND_URL>/social-media/figma/callback`, a page that forwards to the API).
- The flow follows Figma's docs: `https://www.figma.com/oauth` with `state` and PKCE (S256); the code is exchanged at
  `POST https://api.figma.com/v1/oauth/token` with HTTP Basic client credentials; API calls send
  `Authorization: Bearer`. Tokens (access and refresh) are stored AES-256-GCM encrypted in `social_integrations`;
  the access token is refreshed (`POST /v1/oauth/refresh`) a few minutes before it expires, or once after a 401,
  one refresh at a time (a refresh invalidates the previous access token).
- The connection is shared by the workspace. **Disconnect** deletes the tokens; the default file and recent files
  are kept. *Use a personal access token instead* (Settings → Figma) connects with a token from Figma → Settings → Security: it is checked with Figma, stored encrypted and replaces the current connection.

### Choosing the file

**Import from Figma** opens the **default file** directly (set it in Settings → Figma, or with *Set as default* in
the import window). *Change file* opens the file picker: **Recent** files (every file opened is remembered),
**Teams** (Figma has no "my files" endpoint: add a team page link once, then browse its folders and files; needs
`folders:read`), or **Paste a link** (a file, page or frame link). Then it lists the frames with Figma's thumbnails
and imports them as separate designs or one carousel. Re-sync and the version checks use the same connection.

- Text, rectangles, ellipses, fills, gradients, image fills, corner radius, strokes, rotation and opacity
  become editable layers. Vectors, boolean shapes, masks, shapes with shadows and clipped content are rendered
  by Figma and placed as images.
- **Exact size and position:** each design is created with a canvas of the frame's own size (a 1920×1920 frame gives
  a 1920×1920 design, scale 1), so every layer has the same X, Y, W, H as in Figma. 1080×1080, 1080×1350 and
  1080×1920 keep their usual names (1:1, 4:5, 9:16); other sizes show as *Custom* (up to 4000 px, larger frames are
  scaled down). Centered and outside strokes grow the layer box so its size stays exact, cropped images keep their
  crop, vertical text alignment and blend modes are kept, and auto-width text grows from the side it is aligned to.
  Slides of a carousel share one canvas: frames of another size are scaled to fit it.
- **Groups stay groups:** the layers of a Figma group or nested frame are grouped in the studio (they select and
  move together; Ctrl Shift G ungroups them).
- **Groups** keep their exact position and size too (positions come from Figma's absolute boxes, so nested and
  rotated layers land where they are in Figma). A group that isn't inside a frame can be imported on its own: it
  shows in the frame list as a group and becomes a design of its size with a transparent background.
- **Image fills** keep Figma's image adjustments (exposure … shadows), and the colors and gradients painted above
  the image become its editable fill list (each with its opacity).
- **Same layers, same effects:** layer order and names match Figma's Layers panel; group names show in the
  studio's Layers tab (expand a group, click it to select all its layers). A group or instance drawn only with
  vectors (a logo, an icon) becomes one image. Drop shadows (with x/y offset), layer blur and background blur
  (frosted glass) stay editable; Figma is asked to render the rest (masks, inner shadows, several shadows) and the
  import retries renders Figma doesn't return the first time. Blend modes set on fills count as the layer's.
- **Fonts** the studio doesn't ship (for example Atkinson Hyperlegible Next) are loaded from Google Fonts in the
  weights the design uses, and exports embed them.
- **Flipped layers** (rectangles, ellipses, text) stay editable: they import with the flip and the right angle
  instead of being rendered as an image.
- Fonts the studio doesn't load are swapped for the brand fonts, or kept by name (Settings → Figma → Missing
  fonts). The import lists what was simplified.
- Linked slides show **Changed in Figma** when the file changes; **Re-sync** pulls the frame again (undoable).
  Settings → Figma → Re-sync can do it automatically when a linked design is opened, or once a day.

## Drag and drop into the design

- Drag any item from the left panel onto the canvas: **Templates** (yours and the starters), **Elements** (shapes,
  more shapes, icons), **Text** (headings, suggestions, text combos), **Uploads** (backgrounds) and **Brand**
  (logos, brand images, fonts, colors). The new layer is centered on the drop point; text combos land as a block.
  One undo reverts the whole drop. Clicking still adds the item as before.
- A color or a font dropped **on a layer** changes that layer; a color dropped on the page changes the
  background; a headline suggestion dropped on a text replaces its text.
- Drop an image file from your desktop on the canvas to add it where you drop it.
- The page is outlined while you drag, the layer under the pointer is highlighted when the drop would change it,
  and **Esc** cancels. On touch screens, press and hold an item first (so the panel can still be scrolled).

## Mixed text styles

- One text layer can mix styles, like in Figma: font, weight, size, color, italic, underline, letter spacing and
  line height per range of characters (`runs` over the text).
- Double-click a text, select some characters, then press **Ctrl/Cmd B, I or U**, or use the panel: a note says
  how many characters you are styling (*Style all the text* goes back to the whole layer).
- The panel shows **Mixed** for values that differ (like Figma); setting a value for the whole layer replaces the
  mixed ones. Styles follow the text when you edit it.
- Figma imports keep mixed styles (`characterStyleOverrides`), including per-range text case.

## Figma frame picker

- Search by name, page or size; frames are grouped by page; the list scrolls inside the window and keeps its
  position when you select. *Select all* (or *Select N shown* while searching), *Clear*, Shift + click for a range.
- A link to a single frame selects it; a page with many frames starts with nothing selected. Frames with the same
  name show their id.

## Properties panel

- Sections like Figma's (**Position, Text, Appearance, Fill, Image, Stroke, Effects**): click a title to collapse
  it; the choice is remembered on this device. The Design / Layers tabs stay at the top and the layer actions
  (duplicate, order, lock, delete) stay at the bottom while the panel scrolls.
- **Rotation** row: angle, *Rotate 90° right*, *Flip horizontal* (Shift H) and *Flip vertical* (Shift V); the
  shortcuts work on several selected layers too. Buttons show Figma-style tooltips with their shortcut.
- Menus (blend mode, font, weight, image mode) follow the light or dark theme.

## Image adjustments, gradients and menus in the editor

- **Image adjustments** (image layers): Exposure, Contrast, Saturation, Temperature, Tint, Highlights and Shadows,
  -100…100 like Figma, with presets (B&W, Warm, Cool, Vivid, Fade, Dramatic). Double-click a slider to reset it.
  The studio applies them to the image pixels (a quick preview while dragging, full size when the slider rests),
  so the canvas, thumbnails, exports and published images all match. Images from another site that refuses
  cross-origin reads fall back to CSS filters (exposure, contrast, saturation only).
- **Fill list** for images, like Figma's: any number of colors and gradients above the image (top first), each
  with its own opacity, show/hide and remove; *+* adds black at 20%, click a row to edit it (Solid or Gradient).
  The image row sets its mode (Fill, Fit, Stretch, Tile, or Crop when it comes from Figma).
- **Flip** works like Figma's: the layer mirrors across the canvas axis, so a layer rotated 30° shows −30° once
  flipped; several selected layers flip as one block (Shift H / Shift V). Adjustments are stored in `adj` and
  are kept when flipping (older designs are converted when they load).
- **Gradients** (shapes and the image overlay): any number of colors, each with a position and an opacity; drag
  the handles on the bar, set the angle, add or remove colors, reverse. Radial and angular gradients from Figma
  keep their shape and stay editable.
- **Menus**: blend mode, font (each font shown in its own face), weight and image mode open a Figma-style list:
  groups, a check on the current value, keyboard navigation, and a live preview on the canvas while hovering.

## Blend modes and alignment in the editor

- **Blend mode** (under Opacity, for any layer): Normal, Darken, Multiply, Color burn, Lighten, Screen, Plus lighter,
  Color dodge, Overlay, Soft light, Hard light, Difference, Exclusion, Hue, Saturation, Color, Luminosity. Blending
  stays inside the design, and exports and published images render it. Figma's *Plus darker* has no web equivalent
  and *Linear burn* is approximated with Multiply.
- **Text alignment:** left / center / right as before, plus **vertical alignment** (top, middle, bottom) inside the
  text box.
- **Align to page:** six icon buttons (left, center, right, top, middle, bottom) like Figma's Alignment row.
- Undo and redo now also restore the canvas size after a Magic resize.

## Publishing to social networks

Settings → Connected accounts has a **Connect** button per network, per brand. Tokens are encrypted at rest.

| Network | How it connects | What it publishes |
| --- | --- | --- |
| Instagram | Meta app (`META_APP_ID/SECRET`), professional account linked to a Facebook Page | image, carousel (≤10), 9:16 as a Story, **video as a Reel** (or a video Story), first comment |
| Facebook | Meta app, Facebook Page | photo or multi-photo post, **Page video**, first comment |
| LinkedIn | `LINKEDIN_CLIENT_ID/SECRET` (OpenID + Share on LinkedIn) | image or multi-image post on the member's feed, **video**, first comment |
| X | `X_CLIENT_ID/SECRET` (OAuth 2.0 with PKCE) | up to 4 images, **video up to 2:20** (chunked upload) |
| TikTok | `TIKTOK_CLIENT_KEY/SECRET` (Login Kit + Content Posting API) | photo post, **video**; private until TikTok audits the app |
| Telegram | bot token + channel, entered in the Connect dialog | photo or album, **video up to 50 MB**, long captions as a follow-up message |

Until a network's credentials are in `backend/.env`, its Connect button explains the setup (steps, callback URL to
register: `<PUBLIC_API_URL>/social/connections/callback/<network>`). Instagram and TikTok download images from
`PUBLIC_API_URL`, so it must be a public https address in production.

**Video posts.** An imported clip or an animated design is scheduled like an image post; what goes out is its MP4. The
studio prepares it when the post is scheduled (a clip is exported on the server; an animated design is recorded in the
browser tab, which must stay open until it's ready, then uploaded in 8 MB chunks and re-encoded to H.264 + AAC with
ffmpeg). Each post keeps its own copy in `SOCIAL_VIDEO_DIR` (default `backend/storage/social-videos`), served publicly at
`<PUBLIC_API_URL>/social/video/<id>.mp4` with Range requests; files no post uses are removed hourly. Instagram, Facebook
and TikTok download the video from that URL (TikTok also needs the domain verified in its developer portal); LinkedIn,
X and Telegram receive it as an upload. The Schedule dialog checks each network's length limit before you confirm.

**Meta (Facebook and Instagram, one app):** besides the keys, the app must list the API's domain. *Setup help* next to
Connect shows the exact values to copy: App settings → Basic → **App Domains** (`localhost` in development) and
Add platform → **Website** (site URL = `FRONTEND_URL`); Facebook Login for Business → Settings → **Valid OAuth
Redirect URIs** with both `…/callback/fb` and `…/callback/ig`, and Client + Web OAuth login turned on. Without the
domain, Facebook shows "The domain of this URL isn't included in the app's domains". Restart the API after editing
`backend/.env`; *Check again* in the dialog then continues to the sign-in.

- **Publish now** renders the slides in the browser and sends them; the result per network (link to the post, or
  the error) shows in the post. A partly failed post can be retried for the failed networks only; nothing is
  posted twice.
- **Scheduled posts** upload their rendered slides when scheduled; the API publishes them at their time (in the
  time zone they were scheduled in), even with the studio closed, and retries a failed attempt twice
  (2 and 4 minutes later). If the design changes, the studio re-renders the slides of its scheduled posts.
- Each network gets its own caption if one was written, plus the link (with UTM tags if enabled) where links work.
- Posts that fail show as **Failed** in the planner; the post shows why.

## Still simulated in the social workspace

As in the original studio: the AI assistant and its API key fields. The Blog Admin's AI and Framer integrations
are real.
