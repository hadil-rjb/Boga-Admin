import { describe, expect, it } from 'vitest';
import { SIZES, lumOf, parseColor, swapColor, langOf, themeOf, resizePage, swapTheme, textsToTranslate, swapLanguage, versionName } from './variants.js';

const PAL = { dark: '#0B1220', light: '#F8FAFC' };
/** A dark news story: background photo, a glass card with a picture and two texts in it, a white logo, a footer */
const story = () => ({
  bg: '#000000',
  layers: [
    { id: 'bg', type: 'rect', name: 'Background', x: 0, y: 0, w: 1080, h: 1920, fill: '#000000', locked: true },
    { id: 'photo', type: 'image', name: 'BG', x: -200, y: -100, w: 1500, h: 2200, fill: 'url(data:image/png;base64,AA) center/cover' },
    { id: 'logo', type: 'path', name: 'Logo', x: 380, y: 120, w: 320, h: 60, fill: '#FFFFFF', d: 'M0 0L10 0L10 10Z', vw: 10, vh: 10 },
    { id: 'card', type: 'frame', name: 'Card', x: 63, y: 257, w: 953, h: 1200, fill: 'rgba(255,255,255,0.12)', r: 80, al: { d: 'v', g: 40, p: [30, 30, 30, 30], hh: true } },
    { id: 'pic', type: 'image', pid: 'card', x: 93, y: 287, w: 893, h: 500, fill: 'url(data:image/png;base64,BB) center/cover', r: 48 },
    { id: 'title', type: 'text', pid: 'card', x: 93, y: 827, w: 893, h: 140, text: 'Gold hits a record high', color: '#FFFFFF', size: 56, align: 'left', font: 'Inter' },
    { id: 'body', type: 'text', pid: 'card', x: 93, y: 1007, w: 893, h: 300, text: 'Prices rose 2% on Friday.', color: 'rgba(255,255,255,0.8)', size: 40, align: 'left', font: 'Inter' },
    { id: 'accent', type: 'rect', x: 93, y: 1400, w: 200, h: 8, fill: '#FD0E35' },
    { id: 'glow', type: 'ellipse', x: -1000, y: 850, w: 2700, h: 2700, fill: 'radial-gradient(50% 50% at 50% 50%, #FFFFFF 0%, rgba(150,150,150,0) 100%)', blend: 'overlay' },
    { id: 'foot', type: 'text', x: 63, y: 1600, w: 400, h: 40, text: '1.2345', color: '#FFFFFF', size: 22, align: 'left', font: 'Inter' },
  ],
});
const byId = (pg, id) => pg.layers.find((l) => l.id === id);

describe('colours', () => {
  it('reads hex and rgba colours and their luminance', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgba(0, 0, 0, .5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('url(x)')).toBeNull();
    expect(lumOf('#FFFFFF')).toBeCloseTo(1);
    expect(lumOf('#000000')).toBeCloseTo(0);
  });
  it('swaps neutral colours and keeps brand colours', () => {
    expect(swapColor('#FFFFFF', 'light', PAL, 'ink')).toBe('#0B1220');
    expect(swapColor('#111111', 'light', PAL, 'fill')).toBe('#F8FAFC');
    expect(swapColor('#FD0E35', 'light', PAL, 'ink')).toBe('#FD0E35');
    expect(swapColor('rgba(255,255,255,0.12)', 'light', PAL, 'fill')).toMatch(/^rgba\(11,18,32,/); // a glass card stays a veil
  });
});

describe('reading a design', () => {
  it('knows its language and theme', () => {
    expect(langOf([story()])).toBe('en');
    expect(themeOf([story()])).toBe('dark');
    const ar = story(); byId(ar, 'title').text = 'الذهب يسجل رقما قياسيا'; byId(ar, 'body').text = 'ارتفعت الأسعار يوم الجمعة';
    expect(langOf([ar])).toBe('ar');
  });
});

describe('resizePage', () => {
  it('turns a story into a square: backgrounds cover it, the content keeps its proportions, centred', () => {
    const pg = resizePage(story(), [1080, 1920], [1080, 1080]);
    expect(byId(pg, 'bg')).toMatchObject({ x: 0, y: 0, w: 1080, h: 1080 });
    const photo = byId(pg, 'photo');
    expect(photo.w).toBeGreaterThanOrEqual(1080); expect(photo.y).toBeLessThanOrEqual(0); expect(photo.y + photo.h).toBeGreaterThanOrEqual(1080);
    const card = byId(pg, 'card'), title = byId(pg, 'title');
    expect(card.w / card.h).toBeCloseTo(953 / 1200, 2);
    expect(card.y).toBeGreaterThanOrEqual(0); expect(card.y + card.h).toBeLessThanOrEqual(1080);
    expect(title.size).toBeLessThan(56); // type scales with the block
    expect(title.x - card.x).toBeCloseTo((93 - 63) * (card.w / 953), 0); // children follow their frame
    expect(card.al.g).toBeLessThan(40);
    expect(card.h).toBeGreaterThan(1080 * 0.65); // a glow bleeding off the edges is backdrop: it doesn't shrink the content
    expect(byId(pg, 'glow').w).toBeCloseTo(2700 * (1080 / 1080), 0);
  });
  it('keeps a page the same size as it is', () => {
    expect(resizePage(story(), [1080, 1920], [1080, 1920])).toEqual(story());
  });
});

describe('swapTheme', () => {
  it('turns a dark design light: dark text, a veil over the photo, brand colours and pictures kept', () => {
    const pg = swapTheme(story(), 'light', 1080, 1920, PAL);
    expect(byId(pg, 'title').color).toBe('#0B1220');
    expect(byId(pg, 'logo').fill).toBe('#0B1220');
    expect(byId(pg, 'accent').fill).toBe('#FD0E35');
    expect(byId(pg, 'pic').fill).toMatch(/^url\(/);
    const veil = pg.layers.find((l) => l.name === 'Theme veil');
    expect(veil).toMatchObject({ fill: '#F8FAFC', w: 1080, h: 1920 });
    expect(pg.layers.indexOf(veil)).toBe(pg.layers.findIndex((l) => l.id === 'photo') + 1); // over the photo, under the content
  });
});

describe('language', () => {
  it('lists the fixed texts to translate, not numbers or live texts', () => {
    const pg = story(); byId(pg, 'body').feed = '{summary}';
    expect(textsToTranslate([pg], 'ar').map((x) => x.id)).toEqual(['0:title']);
  });
  it('writes the translation right to left, with an Arabic font, mirrored', () => {
    const pg = story(); pg.live = { kind: 'news', lang: 'en', pick: ['n1'] };
    swapLanguage(pg, 0, 'ar', new Map([['0:title', 'الذهب يسجل رقما قياسيا']]), { arabic: 'Tajawal' });
    expect(byId(pg, 'title')).toMatchObject({ text: 'الذهب يسجل رقما قياسيا', dir: 'rtl', align: 'right', font: 'Tajawal' });
    expect(byId(pg, 'foot').align).toBe('right');
    expect(pg.live).toMatchObject({ lang: 'ar', pick: ['n1'] }); // the same story, translated
  });
});

describe('versionName', () => {
  it('names a version after what changed, replacing earlier version words', () => {
    expect(versionName('News', { lang: 'ar', size: '1:1' })).toBe('News · Arabic · Square');
    expect(versionName('News · Arabic · Square', { lang: 'en', theme: 'light' })).toBe('News · English · Light');
    expect(SIZES.map((z) => z.key)).toContain('9:16');
  });
});
