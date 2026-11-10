import { BadRequestException } from "@nestjs/common";

/**
 * Studio Agent: the editor's AI assistant. The design lives in the browser, so the studio runs the loop:
 * it sends the conversation and the design's state, this server asks the model for one turn (text and/or
 * tool calls, with the provider's own tool-use format), the studio runs the tools on the design and sends
 * their results back. The tools below are the editor's actions; the studio implements each one by name.
 */

type Schema = Record<string, unknown>;
export type AgentTool = { name: string; description: string; parameters: Schema };

const str = (description: string, extra: Schema = {}) => ({ type: "string", description, ...extra });
const num = (description: string) => ({ type: "number", description });
const ids = { type: "array", items: { type: "string" }, description: "Layer ids (from the slide's layer list)" };
const page = num("Slide number, 1-based. Default: the current slide");

/** Every property a layer can have; the studio ignores the ones that don't apply to its type */
const LAYER_PROPS: Schema = {
  type: "object",
  description: "Layer properties to set. Units are canvas pixels.",
  properties: {
    name: str("Layer name shown in the Layers list"),
    text: str("Text content (text layers). Use \\n for line breaks"),
    x: num("Left edge"), y: num("Top edge"), w: num("Width"), h: num("Height (text layers grow to fit automatically)"),
    rot: num("Rotation in degrees"), op: num("Opacity 0–1"), hidden: { type: "boolean" }, locked: { type: "boolean" },
    font: str("Font family, e.g. the brand fonts or Inter, Poppins, Montserrat, Cairo (Arabic)"),
    size: num("Font size in px"), weight: num("Font weight 100–900"), color: str("Text colour (#hex or rgba)"),
    align: str("Text alignment", { enum: ["left", "center", "right"] }), lh: num("Line height, e.g. 1.15"), ls: num("Letter spacing in px"),
    dir: str("Text direction", { enum: ["ltr", "rtl"] }), it: { type: "boolean", description: "Italic" }, ul: { type: "boolean", description: "Underline" }, up: { type: "boolean", description: "Uppercase" },
    fill: str("Fill of shapes and image frames: a colour, or a CSS gradient like linear-gradient(135deg,#FD0E35,#7C1D6F)"),
    stroke: str("Border colour (shapes)"), sw: num("Border width"), r: num("Corner radius (rectangles)"),
    shx: num("Shadow x offset"), shy: num("Shadow y offset"), shb: num("Shadow blur"), shc: str("Shadow colour"), sha: num("Shadow opacity 0–1"),
    bl: num("Layer blur in px"), bbl: num("Background blur (frosted glass) in px"),
    fx: { type: "boolean", description: "Flip horizontally" }, fy: { type: "boolean", description: "Flip vertically" },
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "update_layers",
    description: "Change existing layers: move, resize, restyle, rewrite text, show/hide, lock. Several layers in one call.",
    parameters: { type: "object", properties: { page, updates: { type: "array", items: { type: "object", properties: { id: str("Layer id"), props: LAYER_PROPS }, required: ["id", "props"] } } }, required: ["updates"] },
  },
  {
    name: "add_layers",
    description: "Add new layers (drawn on top, in order). kind: text, rect, ellipse, line, icon (an outline icon, coloured by fill), image (a brand logo/asset or a public https picture). Returns the new ids.",
    parameters: {
      type: "object",
      properties: {
        page,
        layers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: str("What to add", { enum: ["text", "rect", "ellipse", "line", "icon", "image"] }),
              props: LAYER_PROPS,
              icon: str("Icon name for kind=icon: star, bell, check, x, plus, search, chat, globe, clock, send, trend, users, user, shield, alert, link, chart, cal, doc, image, layers, layout, palette, wand, sun, moon, eye, lock, download, upload, refresh, history, settings, grid, frame, type, shapes, copy, arrowUp"),
              image: str("For kind=image: 'logo:<id>' or 'asset:<id>' from the brand kit, or an https URL"),
              fit: str("For kind=image: how the picture fills the frame", { enum: ["cover", "contain"] }),
            },
            required: ["kind"],
          },
        },
      },
      required: ["layers"],
    },
  },
  { name: "delete_layers", description: "Delete layers.", parameters: { type: "object", properties: { page, ids }, required: ["ids"] } },
  { name: "duplicate_layers", description: "Duplicate layers, offset by dx/dy (default 30, 30). Returns the new ids.", parameters: { type: "object", properties: { page, ids, dx: num("Horizontal offset"), dy: num("Vertical offset") }, required: ["ids"] } },
  {
    name: "arrange_layers",
    description: "Change the stacking order of layers.",
    parameters: { type: "object", properties: { page, ids, to: str("Where to move them", { enum: ["front", "back", "forward", "backward"] }) }, required: ["ids", "to"] },
  },
  {
    name: "align_layers",
    description: "Align layers to the canvas (one or more layers) or to each other, or distribute them evenly (3+ layers).",
    parameters: {
      type: "object",
      properties: {
        page, ids,
        align: str("Alignment", { enum: ["left", "center", "right", "top", "middle", "bottom", "distribute-x", "distribute-y"] }),
        to: str("Align to the canvas (default) or to the selection's bounds", { enum: ["canvas", "selection"] }),
        margin: num("Distance from the canvas edge for left/right/top/bottom (default 0)"),
      },
      required: ["ids", "align"],
    },
  },
  { name: "set_background", description: "Set the slide background: a colour or a CSS gradient.", parameters: { type: "object", properties: { page, fill: str("Colour or CSS gradient") }, required: ["fill"] } },
  {
    name: "manage_slides",
    description: "Slides: add a blank slide, duplicate, delete, move, or go to (show) a slide. 'index' is 1-based; add/duplicate insert after it.",
    parameters: { type: "object", properties: { action: str("What to do", { enum: ["add", "duplicate", "delete", "move", "go"] }), index: num("Slide number (default: current)"), to: num("New position for move") }, required: ["action"] },
  },
  { name: "resize_canvas", description: "Change the canvas format; every slide's layers are re-flowed (magic resize).", parameters: { type: "object", properties: { ratio: str("Format", { enum: ["1:1", "4:5", "9:16"] }) }, required: ["ratio"] } },
  { name: "rename_design", description: "Rename the design.", parameters: { type: "object", properties: { name: str("New name") }, required: ["name"] } },
  {
    name: "apply_brand_template",
    description: "Replace the current slide with one of the brand's saved templates (ids in the brand kit).",
    parameters: { type: "object", properties: { id: str("Template id") }, required: ["id"] },
  },
  {
    name: "build_live_slide",
    description: "Replace the current slide with a live-data template built from the brand kit: an economic calendar, a price alert (live market price) or a news post (latest headline). Its data then updates on its own.",
    parameters: {
      type: "object",
      properties: {
        kind: str("Template", { enum: ["calendar", "price", "news"] }),
        style: str("Look", { enum: ["dark", "light", "brand"] }),
        lang: str("Language", { enum: ["en", "ar"] }),
        symbol: str("Price alert market, TradingView format, e.g. OANDA:XAUUSD (gold), FX_IDC:EURUSD, BINANCE:BTCUSDT, SP:SPX, NASDAQ:AAPL"),
        source: str("News feed", { enum: ["fxstreet", "cnbc", "marketwatch", "google"] }),
      },
      required: ["kind"],
    },
  },
  {
    name: "write_caption",
    description: "Give the user a social media caption (and hashtags) for this design. It is shown with Copy and Schedule buttons; the slide is not changed.",
    parameters: { type: "object", properties: { caption: str("The caption, in the brand's voice and language") }, required: ["caption"] },
  },
  { name: "select_layer", description: "Select a layer in the editor so the user sees it (or pass no id to deselect).", parameters: { type: "object", properties: { id: str("Layer id") } } },
  { name: "get_slide", description: "Read the layers of another slide (the current slide is already in the context).", parameters: { type: "object", properties: { index: num("Slide number, 1-based") }, required: ["index"] } },
  { name: "view_slide", description: "Look at a picture of a slide as it renders now, to check the result of your changes.", parameters: { type: "object", properties: { index: num("Slide number, 1-based (default: current)") } } },
  {
    name: "view_reference",
    description: "Look at one of the brand's reference designs (ids in brand.references): a picture and its layers. Use it to see how the brand handles a layout before building your own.",
    parameters: { type: "object", properties: { id: str("Reference id") }, required: ["id"] },
  },
  {
    name: "check_design",
    description: "Check a slide against the brand's design system: off-brand fonts, colours and sizes, text in the margins, weak contrast, missing logo. Call it before you finish and fix what it reports.",
    parameters: { type: "object", properties: { page } },
  },
];

export const AGENT_PROMPT = `You are the design agent inside Boğa Studio, a social media post editor. You edit the user's open design with tools, like a skilled designer working in the editor.

How to work:
- Act: when the user asks for a change, make it with the tools instead of describing it. Batch related changes in one call (update_layers takes many layers).
- Use the layer ids from the context. Canvas coordinates are pixels, origin top-left; keep important content inside the canvas with comfortable margins (about 60–80 px).
- Respect the brand kit: its colours, fonts and logos, its voice for any copy, and its language. Keep text readable (strong contrast) and the hierarchy clear.
- Text layers grow in height to fit; set w for the text box width. Keep line lengths reasonable.
- After visual changes that matter (layout, colours, new elements), call view_slide once to check the result and fix problems you see.
- Live data slides (calendar, price alert, news) refresh their own texts; restyle them freely but don't rewrite their live texts.
- If the request is unclear or impossible, say so briefly and suggest what you can do.
- Finish with one or two short sentences saying what you changed. No markdown headings, no lists unless asked. Answer in the user's language.`;

/** Added to the prompt only when the brand has a design system in the context */
export const DESIGN_SYSTEM_PROMPT = `The brand has a design system (brand.designSystem in the context):
- Follow the design system. It is how this brand designs: the brand kit's colours and fonts are the ingredients, the design system is the recipe.
- Sizes and distances are for a 1080 px wide canvas. Multiply them by width / 1080 for the canvas you are on.
- For a new design, choose the layout pattern whose "when" fits the request and build its slots, adapting them to the canvas ratio. If no pattern fits, compose from the type scale, the margins and the colour pairs.
- Use only the listed colour pairs for text on backgrounds.
- When unsure how the brand handles something, look at a reference with view_reference.
- Before you finish, call check_design and fix what it reports. If you keep a violation on purpose, say so.
- The user's request wins over the system when they conflict. Say what you departed from.`;

/** The agent's system prompt: today's prompt, plus the design system section when the context carries one */
export function agentSystemPrompt(context: string): string {
  return context.includes('"designSystem":{') ? `${AGENT_PROMPT}\n\n${DESIGN_SYSTEM_PROMPT}` : AGENT_PROMPT;
}

/* ---------- conversation: provider-neutral, as the studio sends it ---------- */
export type AgentCall = { id: string; name: string; input: Record<string, unknown> };
export type AgentMsg =
  | { role: "user"; text: string; image?: string }
  | { role: "assistant"; text?: string; calls?: AgentCall[] }
  | { role: "tool"; results: { id: string; text: string; image?: string }[] };

const DATA_IMG = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
const clipText = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Checks and trims what the browser sent: roles, sizes, ids, at most `maxImages` pictures (the latest ones) */
export function cleanMessages(raw: unknown, maxImages = 3): AgentMsg[] {
  if (!Array.isArray(raw) || !raw.length) throw new BadRequestException("No messages");
  const names = new Set(AGENT_TOOLS.map((t) => t.name));
  const out: AgentMsg[] = raw.slice(-80).map((m: any) => {
    if (m?.role === "user") return { role: "user", text: clipText(m.text, 4000) || "(no text)", image: DATA_IMG.test(m.image || "") ? m.image : undefined };
    if (m?.role === "assistant") {
      const calls = (Array.isArray(m.calls) ? m.calls : []).slice(0, 20).filter((c: any) => ID_RE.test(c?.id || "") && names.has(c?.name)).map((c: any) => ({ id: c.id, name: c.name, input: c.input && typeof c.input === "object" ? c.input : {} }));
      return { role: "assistant", text: clipText(m.text, 8000), calls };
    }
    if (m?.role === "tool") {
      const results = (Array.isArray(m.results) ? m.results : []).slice(0, 20).filter((r: any) => ID_RE.test(r?.id || "")).map((r: any) => ({ id: r.id, text: clipText(r.text, 20000) || "Done", image: DATA_IMG.test(r.image || "") ? r.image : undefined }));
      return { role: "tool", results };
    }
    throw new BadRequestException("Unknown message role");
  });
  // pictures cost a lot of tokens: keep only the latest ones
  let n = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i] as any;
    if (m.role === "user" && m.image && ++n > maxImages) delete m.image;
    if (m.role === "tool") m.results.forEach((r: any) => { if (r.image && ++n > maxImages) delete r.image; });
  }
  if (out[0].role !== "user") throw new BadRequestException("The conversation must start with the user");
  return out;
}

const imgPart = (url: string) => { const m = DATA_IMG.exec(url)!; return { media: `image/${m[1]}`, data: m[2] }; };

export function toAnthropic(msgs: AgentMsg[]) {
  return msgs.map((m) => {
    if (m.role === "user") return { role: "user", content: [...(m.image ? [{ type: "image", source: { type: "base64", media_type: imgPart(m.image).media, data: imgPart(m.image).data } }] : []), { type: "text", text: m.text }] };
    if (m.role === "assistant") return { role: "assistant", content: [...(m.text ? [{ type: "text", text: m.text }] : []), ...(m.calls || []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))].concat(!m.text && !(m.calls || []).length ? [{ type: "text", text: "(no answer)" }] : []) };
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result", tool_use_id: r.id,
        content: [{ type: "text", text: r.text }, ...(r.image ? [{ type: "image", source: { type: "base64", media_type: imgPart(r.image).media, data: imgPart(r.image).data } }] : [])],
      })),
    };
  });
}

export function toOpenAi(system: string, msgs: AgentMsg[], vision: boolean) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of msgs) {
    if (m.role === "user") out.push({ role: "user", content: vision && m.image ? [{ type: "text", text: m.text }, { type: "image_url", image_url: { url: m.image } }] : m.text });
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.text || null, ...((m.calls || []).length ? { tool_calls: m.calls!.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) });
    else m.results.forEach((r) => out.push({ role: "tool", tool_call_id: r.id, content: r.text + (r.image ? "\n(A picture of the slide was taken, but this model can't see pictures.)" : "") }));
  }
  return out;
}
