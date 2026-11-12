/* ============================================================
   Studio home, Create block (Unified Studio plan, Task 7): the user picks a size, or a starting point, never an editor.
   - Size: a blank design at that size. It is a post; pages make it a carousel; Animate makes it a video, any time.
   - Start from: a template, a video file (captions), a reference video (copy its look), frames from Figma.
   Pure: the data and the markup, given the page's helpers ({ ic, esc, shapeOf }). engine.js draws it on the Studio page.
   ============================================================ */

import { refsStripHTML, REFS_MAX } from './agent-history.js';

/** [ratio, label, size line, pages] */
export const SIZES = [
  ['1:1', 'Square', '1080 × 1080', 1],
  ['4:5', 'Portrait', '1080 × 1350', 1],
  ['9:16', 'Story / Reel', '1080 × 1920', 1],
  ['1920x1080', 'Landscape', '1920 × 1080', 1],
  ['1280x720', 'Thumbnail', '1280 × 720', 1],
  ['4:5', 'Carousel', '3 pages · 4:5', 3],
];

/** [action, label, one line, icon, title] */
export const STARTS = [
  ['crTemplates', 'Template', 'Your brand templates', 'layout', 'Show your templates below'],
  ['crUpload', 'Upload a video', 'Add captions to your clip', 'upload', 'Opens an empty video and asks for your file'],
  ['ftNew', 'Match a reference', 'Copy a video’s look and captions', 'play37', 'Upload a clip and a reference video: copies the reference’s look and subtitles'],
  ['figma', 'Import from Figma', 'Frames become editable layers', 'figma', 'Choose frames in a Figma file'],
];

export function createBlockHTML({ ic, esc, shapeOf }) {
  const sizes = SIZES.map(([r, l, s, n]) => `<button class="tile" data-act="crSize" data-r="${esc(r)}" data-n="${n}" title="A blank ${esc(l.toLowerCase())} design, ${esc(s)}">`
    + `<span class="shape"><i style="${shapeOf(r)}"></i></span><span><b>${esc(l)}</b><small>${esc(s)}</small></span></button>`).join('');
  const starts = STARTS.map(([a, l, s, i, t]) => `<button class="tile" data-act="${a}" title="${esc(t)}">`
    + `<span class="shape ico">${ic(i, 18)}</span><span><b>${esc(l)}</b><small>${esc(s)}</small></span></button>`).join('');
  return `<section class="cr37 cr-u" aria-label="Create">
      <div class="cr37-g"><div class="cr37-h"><b>Size</b><small>Start blank. Add pages for a carousel, or animate it into a video any time.</small></div><div class="cr37-row cr-sizes">${sizes}</div></div>
      <div class="cr37-g"><div class="cr37-h"><b>Start from</b></div><div class="cr37-row cr-starts">${starts}</div></div></section>`;
}

/* ============================================================
   Overview, Prompt box: describe what you want, the Studio Agent builds it in a new design.
   Sending creates the design, opens the editor on the Agent tab and runs the prompt there (engine.js).
   Pure, like the Create block: data, words and markup.
   ============================================================ */

export const PROMPT_MAX = 600;

/** k: the choice · ratio: '' lets the agent choose · pages: pages the design starts with */
export const PROMPT_SIZES = [
  { k: 'auto', label: 'Auto size', line: 'The agent picks the size and pages', ratio: '', pages: 1 },
  { k: '1:1', label: 'Square', line: '1080 × 1080', ratio: '1:1', pages: 1 },
  { k: '4:5', label: 'Portrait', line: '1080 × 1350', ratio: '4:5', pages: 1 },
  { k: '9:16', label: 'Story / Reel', line: '1080 × 1920', ratio: '9:16', pages: 1 },
  { k: '1920x1080', label: 'Landscape', line: '1920 × 1080', ratio: '1920x1080', pages: 1 },
  { k: 'carousel', label: 'Carousel', line: '3 pages · 4:5', ratio: '4:5', pages: 3 },
];

/** [chip, the prompt it writes in the box] */
export const PROMPT_IDEAS = [
  ['Launch announcement', 'An announcement post for our new product launch, with a bold headline, one line of detail and a call to action'],
  ['Tips carousel', 'A 3-page carousel with three practical tips for our audience: a cover, the tips, and a closing page with a call to action'],
  ['Quote post', 'A quote post with a short, inspiring line in our brand voice, our logo and plenty of space'],
  ['Story promo', 'A Story promoting a limited-time offer, with the offer large in the middle and a clear call to action'],
];

export const promptSize = (k) => PROMPT_SIZES.find((s) => s.k === k) || PROMPT_SIZES[0];

/** What the agent is told besides the user's words (not shown in the chat) */
export function promptNote(k) {
  const s = promptSize(k), base = 'This is a new, empty design, created from the prompt box on the Overview for this request. Build it from scratch with the brand kit and its design system, if it has one, then check the result.';
  if (!s.ratio) return `${base} Choose the canvas size and the number of pages that fit the request best (resize_canvas, manage_slides) before adding layers.`;
  return `${base} The user chose ${s.label} (${s.line})${s.pages > 1 ? `, ${s.pages} pages: design every page` : ''}. Keep this size.`;
}

/** The new design's name: the start of the prompt, cut at a word */
export function promptName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'Untitled design';
  return t.length > 44 ? t.slice(0, 44).replace(/\s+\S*$/, '') + '…' : t;
}

/** The row under the text: size, model, Send. model: null while loading · { none: true } · { name, menu } */
export function promptBarHTML({ ic, esc }, { text = '', size = 'auto', open = '', model = null, refs = [] }) {
  const s = promptSize(size);
  const sizeMenu = open !== 'size' ? '' : `<div class="hp-menu" role="menu" aria-label="Choose the size">${PROMPT_SIZES.map((x) => `<button class="hp-mi${x.k === s.k ? ' on' : ''}" role="menuitemradio" data-act="hpPickSize" data-k="${esc(x.k)}" aria-checked="${x.k === s.k}"><span class="grow"><b>${esc(x.label)}</b><small>${esc(x.line)}</small></span>${x.k === s.k ? ic('check', 14) : ''}</button>`).join('')}</div>`;
  const sizeChip = `<span class="hp-w"><button class="hp-chip${open === 'size' ? ' on' : ''}" data-act="hpSize" aria-haspopup="menu" aria-expanded="${open === 'size'}" title="Size of the new design">${ic('layout', 14)}<span>${esc(s.label)}</span>${ic('chevD', 12)}</button>${sizeMenu}</span>`;
  const modelChip = !model || model.none ? '' : `<span class="hp-w hp-mw"><button class="hp-chip ghost${open === 'model' ? ' on' : ''}" data-act="hpModel" aria-haspopup="menu" aria-expanded="${open === 'model'}" title="Model the agent uses">${ic('studio', 14)}<span>${esc(model.name)}</span>${ic('chevD', 12)}</button>${open === 'model' ? model.menu || '' : ''}</span>`;
  const end = model && model.none
    ? `<span class="hp-hint">Add a Claude or Groq key to create with AI</span><button class="btn secondary sm hp-setup" data-act="agModelSetup">${ic('settings', 14)}Set up AI</button>`
    : `<button class="hp-send" id="hpSend" data-act="hpSend" title="Create" aria-label="Create"${String(text).trim() || (refs || []).length ? '' : ' disabled'}>${ic('arrowUp', 18)}</button>`;
  const attach = model && model.none ? '' : `<button class="hp-chip hp-att" data-act="hpAttach" title="Add inspiration pictures (up to ${REFS_MAX}): the agent takes their style" aria-label="Add inspiration pictures">${ic('image', 14)}<span>Inspiration</span></button>`;
  // like Claude's composer: what you make on the left, the model next to Send on the right
  return `${attach}${sizeChip}<span class="grow"></span>${modelChip}${end}`;
}

/** The hero's first line: a greeting by the time of day, with the first name when there is one */
export function promptGreeting(name, hour) {
  const part = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = String(name || '').trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

/** state: the bar's state, plus greeting (the title) */
export function promptBlockHTML(h, state) {
  const { ic, esc } = h;
  return `<section class="hp" aria-label="Create with AI">
      <header class="hp-head"><h2 class="hp-t">${esc(state.greeting || 'What do you want to create?')}</h2></header>
      <div class="hp-box" id="hpBox"><div id="hpRefs">${refsStripHTML({ ic, esc }, state.refs || [], 'hpRefDrop')}</div><textarea id="hpIn" rows="2" maxlength="${PROMPT_MAX}" placeholder="What do you want to create? Describe a post, a carousel or a story…" aria-label="Describe what you want to create">${esc(state.text || '')}</textarea>
        <div class="hp-bar" id="hpBar">${promptBarHTML(h, state)}</div></div>
      <div class="hp-ideas" aria-label="Ideas">${PROMPT_IDEAS.map(([l], i) => `<button class="hp-idea" data-act="hpIdea" data-i="${i}" title="Write this idea in the box">${esc(l)}</button>`).join('')}</div></section>`;
}
