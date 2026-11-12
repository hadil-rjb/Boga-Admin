import { describe, it, expect } from 'vitest';
import { SIZES, STARTS, createBlockHTML } from './home.js';

const h = { ic: (n) => `<i data-ic="${n}"></i>`, esc: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'), shapeOf: () => 'width:10px;height:10px' };

describe('Create block', () => {
  it('sizes cover square, portrait, story, landscape, thumbnail and a 3-page carousel', () => {
    expect(SIZES.map((s) => s[0])).toEqual(['1:1', '4:5', '9:16', '1920x1080', '1280x720', '4:5']);
    expect(SIZES.find((s) => s[1] === 'Carousel')[3]).toBe(3);
    for (const [r, l, , n] of SIZES) {
      expect(r).toMatch(/^\d+(:|x)\d+$/);
      expect(l).toMatch(/^[A-Z][A-Za-z /]*[a-z]$/);
      expect(n).toBeGreaterThan(0);
    }
  });
  it('every old tile is reachable: sizes for posts and videos, starts for footage, templates and Figma', () => {
    const acts = STARTS.map((s) => s[0]);
    expect(acts).toEqual(['crTemplates', 'crUpload', 'ftNew', 'figma']);
    const ratios = new Set(SIZES.map((s) => s[0]));
    for (const r of ['1:1', '4:5', '9:16', '1920x1080', '1280x720']) expect(ratios.has(r)).toBe(true); // every old video format's ratio
  });
  it('draws one button per size and per start, with no editor choice and no emoji', () => {
    const html = createBlockHTML(h);
    expect(html.match(/data-act="crSize"/g)).toHaveLength(SIZES.length);
    for (const [a] of STARTS) expect(html).toContain(`data-act="${a}"`);
    expect(html).toContain('data-n="3"');
    expect(html).not.toMatch(/mo37New|ftBlank|Videos|Posts/);
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
  it('escapes its text', () => {
    const html = createBlockHTML(h);
    expect(html).toContain('Story / Reel');
    expect(html).toContain('video’s look');
  });
});

import { PROMPT_SIZES, PROMPT_IDEAS, PROMPT_MAX, promptSize, promptNote, promptName, promptGreeting, promptBarHTML, promptBlockHTML } from './home.js';

describe('Prompt box', () => {
  it('offers Auto first, then the fixed sizes and a 3-page carousel', () => {
    expect(PROMPT_SIZES.map((s) => s.k)).toEqual(['auto', '1:1', '4:5', '9:16', '1920x1080', 'carousel']);
    expect(promptSize('auto').ratio).toBe('');
    expect(promptSize('carousel')).toMatchObject({ ratio: '4:5', pages: 3 });
    expect(promptSize('nope').k).toBe('auto');
  });
  it('tells the agent the design is new, and whether the size is its choice', () => {
    expect(promptNote('auto')).toMatch(/new, empty design/);
    expect(promptNote('auto')).toMatch(/resize_canvas/);
    expect(promptNote('auto')).toMatch(/brand kit and its design system, if it has one/);
    expect(promptNote('9:16')).toMatch(/Story \/ Reel/);
    expect(promptNote('9:16')).toMatch(/Keep this size/);
    expect(promptNote('carousel')).toMatch(/3 pages/);
  });
  it('names the design from the prompt, cut at a word', () => {
    expect(promptName('  Launch   post for our new app ')).toBe('Launch post for our new app');
    const n = promptName('A very long description of a carousel about the five habits of great product designers');
    expect(n.length).toBeLessThanOrEqual(45);
    expect(n).toMatch(/…$/);
    expect(n).not.toMatch(/\s…$/);
    expect(promptName('   ')).toBe('Untitled design');
  });
  it('draws the box with the draft, the ideas and a disabled Send while empty', () => {
    const empty = promptBlockHTML(h, { text: '', size: 'auto', model: { name: 'Claude Fable' } });
    expect(empty).toContain('id="hpIn"');
    expect(empty).toContain(`maxlength="${PROMPT_MAX}"`);
    expect(empty).toMatch(/id="hpSend"[^>]* disabled/);
    expect(empty.match(/data-act="hpIdea"/g)).toHaveLength(PROMPT_IDEAS.length);
    const typed = promptBlockHTML(h, { text: 'A <b>post</b>', size: '1:1', model: { name: 'Claude Fable' } });
    expect(typed).toContain('A &lt;b>post&lt;/b></textarea>');
    expect(typed).not.toMatch(/id="hpSend"[^>]* disabled/);
    expect(typed).toContain('Square');
    expect(typed).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
  it('greets by the time of day with the first name, and the hero shows it', () => {
    expect(promptGreeting('Hadil Rejeb', 9)).toBe('Good morning, Hadil');
    expect(promptGreeting('Hadil', 14)).toBe('Good afternoon, Hadil');
    expect(promptGreeting('', 21)).toBe('Good evening');
    expect(promptGreeting('A', 2)).toBe('Good evening, A');
    const html = promptBlockHTML(h, { text: '', size: 'auto', model: null, greeting: 'Good morning, <Hadil>' });
    expect(html).toContain('Good morning, &lt;Hadil>');
    expect(html).toContain('placeholder="What do you want to create? Describe a post');
    expect(promptBlockHTML(h, { text: '', size: 'auto', model: null })).toContain('<h2 class="hp-t">What do you want to create?</h2>');
  });
  it('opens one menu at a time and marks the chosen size', () => {
    const bar = promptBarHTML(h, { text: '', size: '9:16', open: 'size', model: { name: 'M', menu: '<div class="ag-mm"></div>' } });
    expect(bar.match(/data-act="hpPickSize"/g)).toHaveLength(PROMPT_SIZES.length);
    expect(bar).toMatch(/data-k="9:16"[^>]*aria-checked="true"/);
    expect(bar).not.toContain('ag-mm');
    expect(promptBarHTML(h, { text: '', size: 'auto', open: 'model', model: { name: 'M', menu: '<div class="ag-mm"></div>' } })).toContain('ag-mm');
  });
  it('without an AI model, Send becomes a way to set one up; while models load, neither shows a model', () => {
    const none = promptBarHTML(h, { text: 'x', size: 'auto', model: { none: true } });
    expect(none).toContain('data-act="agModelSetup"');
    expect(none).not.toContain('id="hpSend"');
    const loading = promptBarHTML(h, { text: 'x', size: 'auto', model: null });
    expect(loading).toContain('id="hpSend"');
    expect(loading).not.toContain('data-act="hpModel"');
  });
});
