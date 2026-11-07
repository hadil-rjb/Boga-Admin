import { describe, it, expect } from 'vitest';
import { filterRows, fold, reelCaptions, linesOf, capsView, toggleCaptions, editCaptions, rebuildFromVoiceover, prepareReel, hasVoiceover, captionsOn, captionFrame, presetsFor, addBrandStyle, pushRecent, applyPresetTo, applyBrandStyle, editStyle, removeBrandStyle, langFromLines, captionLang, styleLabel, BRAND_STYLE_MAX, scriptAction, srtAction, setLines, SPREAD_NOTE, PENDING_NOTE, applySrt, decodeSubtitleBytes, fileBase } from './caption-panels.js';
import { needsRebuild, voSig } from './caption-sources.js';
import { capsOf as capsOf15 } from './caption-store.js';

const ln = (id, text, start = 0) => ({ id, start, end: start + 1000, words: text.split(' ').map((t, k) => ({ t, s: start + k * 100, e: start + k * 100 + 100 })) });
const scene = (dur, vo) => ({ id: 'p' + dur, layers: [], scene: { k: 'body', dur, tr: 'cut', trd: 400, ...(vo ? { vo } : {}) } });
const reel = (extra = {}) => ({ motion: { fmt: 'reel', fps: 30 }, ratio: '9:16', pages: [scene(3000, { text: 'Hello there friends', src: 'a.mp3', dur: 1200 }), scene(2000, { text: 'Bye now', src: 'b.mp3', dur: 800 })], ...extra });
const words = (lines) => lines.flatMap((l) => l.words.map((w) => w.t));

describe('filterRows', () => {
  const lines = [ln('a', 'مَرْحَبًا بِكُمْ في القناة'), ln('b', 'Café crème au lait'), ln('c', 'أهلاً وسهلاً'), ln('d', 'Nothing here')];
  it('an empty search keeps every line', () => {
    expect(filterRows(lines, '')).toEqual(lines);
    expect(filterRows(lines, '   ')).toEqual(lines);
  });
  it('matches Arabic ignoring diacritics, tatweel and hamza forms', () => {
    expect(filterRows(lines, 'مرحبا').map((l) => l.id)).toEqual(['a']);
    expect(filterRows(lines, 'بكم').map((l) => l.id)).toEqual(['a']);
    expect(filterRows(lines, 'اهلا').map((l) => l.id)).toEqual(['c']);
    expect(filterRows(lines, 'مـرحبا').map((l) => l.id)).toEqual(['a']);
  });
  it('matches Latin substrings ignoring case and accents', () => {
    expect(filterRows(lines, 'CAFE').map((l) => l.id)).toEqual(['b']);
    expect(filterRows(lines, 'creme au').map((l) => l.id)).toEqual(['b']);
    expect(filterRows(lines, 'zzz')).toEqual([]);
  });
  it('fold strips marks and lowercases', () => {
    expect(fold('Él ÉTÉ')).toBe('el ete');
    expect(fold('مَرْحَبًا')).toBe('مرحبا');
  });
});

describe('reelCaptions', () => {
  it('builds the lines from the voice-over when the source is voiceover', () => {
    const d = reel({ captions: { on: true, lines: [], style: null, preset: null, source: 'voiceover', lang: null, voSig: null } });
    const lines = reelCaptions(d);
    expect(words(lines)).toEqual(['Hello', 'there', 'friends', 'Bye', 'now']);
    expect(lines[0].start).toBe(150); // scene start + LEAD
    expect(lines.find((l) => l.words[0].t === 'Bye').start).toBe(3150);
    // no line runs across two scenes
    for (const l of lines) expect(l.end <= 3000 || l.start >= 3000).toBe(true);
  });
  it('is rebuilt when the voice-over changes, with stable ids', () => {
    const d = reel({ captions: { on: true, lines: [], source: 'voiceover' } });
    const a = reelCaptions(d);
    expect(reelCaptions(d).map((l) => l.id)).toEqual(a.map((l) => l.id));
    d.pages[1].scene.vo = { ...d.pages[1].scene.vo, text: 'See you soon' };
    expect(words(reelCaptions(d))).toEqual(['Hello', 'there', 'friends', 'See', 'you', 'soon']);
  });
  it('leaves manual lines untouched', () => {
    const mine = [ln('m1', 'my own words', 100)];
    const d = reel({ captions: { on: true, lines: mine, source: 'manual', voSig: 'x' } });
    expect(reelCaptions(d)).toBe(mine);
  });
  it('a legacy reel (audio.captions, no d.captions) reads as voice-over captions, on as the switch was', () => {
    const d = reel({ audio: { captions: true } });
    expect(capsView(d).on).toBe(true);
    expect(words(reelCaptions(d)).length).toBe(5);
    expect(capsView(reel()).on).toBe(false);
    expect(d.captions).toBeUndefined(); // reading never writes
  });
  it('a scene with a script line but no voice yet spreads it over the scene', () => {
    const d = reel(); d.pages[1].scene.vo = { text: 'Only text' };
    const last = reelCaptions(d).find((l) => l.words[0].t === 'Only');
    expect(last.start).toBe(3000); expect(last.end).toBe(5000);
  });
  it('hasVoiceover: some scene has a voice-over line', () => {
    expect(hasVoiceover(reel())).toBe(true);
    expect(hasVoiceover({ ...reel(), pages: [scene(1000), scene(1000, { text: '  ' })] })).toBe(false);
  });
  it('linesOf: the reel\'s computed lines, the video\'s stored ones', () => {
    const v = { footage: { src: 'x' }, captions: { on: true, lines: [ln('a', 'hi')], source: 'speech' } };
    expect(linesOf(v)).toBe(v.captions.lines);
    expect(words(linesOf(reel()))).toEqual(['Hello', 'there', 'friends', 'Bye', 'now']);
  });
});

describe('toggleCaptions', () => {
  it('writes captions.on', () => {
    const d = { footage: { src: 'x' }, captions: { on: true, lines: [] } };
    toggleCaptions(d); expect(d.captions.on).toBe(false);
    toggleCaptions(d); expect(d.captions.on).toBe(true);
  });
  it('on a legacy reel it moves the switch to d.captions.on', () => {
    const d = reel({ audio: { captions: true } });
    toggleCaptions(d);
    expect(d.captions.on).toBe(false); expect(d.captions.source).toBe('voiceover');
    expect('captions' in d.audio).toBe(false);
  });
  it('on a reel never captioned it turns them on', () => {
    const d = reel(); toggleCaptions(d); expect(d.captions.on).toBe(true);
  });
});

describe('editCaptions', () => {
  it('on a voice-over reel: works on the built lines, then the source is manual with the voice-over signature', () => {
    const d = reel({ captions: { on: true, lines: [], source: 'voiceover' } });
    editCaptions(d, (ls) => ls.slice(1));
    expect(d.captions.source).toBe('manual');
    expect(d.captions.voSig).toBe(voSig(d.pages));
    expect(d.captions.lines.length).toBe(reelCaptions(reel({ captions: { source: 'voiceover' } })).length - 1);
    expect(needsRebuild(d.captions, d.pages)).toBe(false);
    d.pages[0].scene.vo.text = 'Changed';
    expect(needsRebuild(d.captions, d.pages)).toBe(true);
    expect(reelCaptions(d)).toBe(d.captions.lines); // hand edits stay
  });
  it('on a video: edits the stored lines and sets the source to manual', () => {
    const d = { footage: { src: 'x' }, captions: { on: true, lines: [ln('a', 'hi'), ln('b', 'yo', 2000)], source: 'speech', voSig: null } };
    editCaptions(d, (ls) => ls.filter((l) => l.id !== 'a'));
    expect(d.captions.lines.map((l) => l.id)).toEqual(['b']);
    expect(d.captions.source).toBe('manual');
    expect(d.captions.voSig).toBe(null);
  });
  it('rebuildFromVoiceover goes back to the voice-over lines', () => {
    const d = reel({ captions: { on: true, lines: [ln('m', 'mine')], source: 'manual', voSig: 'old' } });
    rebuildFromVoiceover(d);
    expect(d.captions.source).toBe('voiceover');
    expect(words(reelCaptions(d))).toEqual(['Hello', 'there', 'friends', 'Bye', 'now']);
    expect(needsRebuild(d.captions, d.pages)).toBe(false);
  });
});

describe('prepareReel', () => {
  it('a reel without captions gets them off, from the voice-over', () => {
    const d = reel();
    expect(prepareReel(d)).toBe(true);
    expect(d.captions).toMatchObject({ on: false, source: 'voiceover', lines: [] });
    expect(prepareReel(d)).toBe(false);
  });
  it('moves the legacy switch', () => {
    const d = reel({ audio: { captions: true, duck: true } });
    expect(prepareReel(d)).toBe(true);
    expect(d.captions.on).toBe(true); expect('captions' in d.audio).toBe(false);
  });
  it('leaves videos and stills alone', () => {
    const v = { footage: { src: 'x' } };
    expect(prepareReel(v)).toBe(false); expect(v.captions).toBeUndefined();
  });
});

describe('fix round 1', () => {
  it('the built lines follow a scene\'s length and its voice clip, not only its start', () => {
    const d = reel(); d.pages[1].scene.vo = { text: 'Only text' };
    expect(reelCaptions(d).at(-1).end).toBe(5000);
    d.pages[1].scene.dur = 4000; // the last scene: no start moves
    expect(reelCaptions(d).at(-1).end).toBe(7000);
    d.audio = { track: { src: 't.mp3', at: 0, dur: 3500 } }; // a whole-video voice: the script-only line ends with it (+ 400 ms)
    expect(reelCaptions(d).at(-1).end).toBe(3900);
    d.pages[1].scene.vo = { text: 'Only text', src: 'c.mp3' }; // a clip added (length unknown yet): the line is rebuilt
    const before = reelCaptions(d);
    d.pages[1].scene.vo = { text: 'Only text', src: 'c.mp3', dur: 1000 };
    expect(reelCaptions(d)).not.toBe(before);
    expect(reelCaptions(d).at(-1).start).toBe(3150);
  });
  it('captionsOn: a stored boolean wins, else the kind\'s default', () => {
    expect(captionsOn({ footage: { src: 'x' } })).toBe(true);
    expect(captionsOn({ footage: { src: 'x' }, captions: { lines: [] } })).toBe(true);
    expect(captionsOn({ footage: { src: 'x' }, captions: { on: false } })).toBe(false);
    expect(captionsOn(reel())).toBe(false);
    expect(captionsOn(reel({ audio: { captions: true } }))).toBe(true);
    expect(captionsOn(reel({ captions: { lines: [] } }))).toBe(false);
    expect(captionsOn(reel({ captions: { on: true } }))).toBe(true);
  });
  it('toggleCaptions flips what captionsOn says, also when on was never stored', () => {
    const v = { footage: { src: 'x' }, captions: { lines: [] } };
    toggleCaptions(v); expect(v.captions.on).toBe(false);
  });
  it('captionFrame: null when off or between lines, the lines and style when one shows', () => {
    const d = reel({ captions: { on: true, lines: [], source: 'voiceover' } });
    expect(captionFrame(d, 50)).toBeNull(); // before the LEAD
    expect(captionFrame(d, 200).lines.length).toBeGreaterThan(0);
    d.captions.on = false; expect(captionFrame(d, 200)).toBeNull();
    d.captions.on = true; d.captions.style = { offset: 1000 };
    expect(captionFrame(d, 200)).toBeNull(); // the offset delays the line
    const mine = [ln('p', 'drag', 0)];
    expect(captionFrame(d, 1500, mine).lines).toBe(mine);
  });
});

describe('Styles panel helpers', () => {
  const brandStyles = [{ id: 'b1', name: 'Our Karaoke', style: { size: 0.05 } }, { id: 'b2', name: 'Plain', style: { size: 0.04 } }];
  it('presetsFor filters by category, search, recent and brand', () => {
    const all = presetsFor('all', '', [], []);
    expect(all.length).toBeGreaterThan(20);
    const kar = presetsFor('karaoke', '', [], []);
    expect(kar.length).toBeGreaterThan(0);
    expect(kar.every((p) => p.cat === 'karaoke')).toBe(true);
    expect(presetsFor('all', 'IMPACT', [], []).map((p) => p.id)).toContain('viral-impact');
    expect(presetsFor('all', 'zzzzqq', [], [])).toEqual([]);
    expect(presetsFor('recent', '', ['viral-yellow', 'nope', 'viral-impact'], []).map((p) => p.id)).toEqual(['viral-yellow', 'viral-impact']);
    expect(presetsFor('brand', '', [], brandStyles).map((p) => p.id)).toEqual(['b1', 'b2']);
    expect(presetsFor('brand', 'plain', [], brandStyles).map((p) => p.id)).toEqual(['b2']);
    expect(presetsFor('brand', '', [], brandStyles).every((p) => p.brand)).toBe(true);
  });
  it('a 21st brand style is refused', () => {
    let list = [];
    for (let i = 0; i < BRAND_STYLE_MAX; i++) { const r = addBrandStyle(list, 'S' + i, { size: 0.05 }, () => 'id' + i); expect(r.ok).toBe(true); list = r.styles; }
    expect(list.length).toBe(20);
    expect(addBrandStyle(list, 'One more', { size: 0.05 }).ok).toBe(false);
    expect(addBrandStyle([], '  ', { size: 0.05 }).ok).toBe(true); // an empty name falls back to a default
  });
  it('pushRecent keeps the last 8, newest first, without repeats', () => {
    let r = []; for (let i = 0; i < 10; i++) r = pushRecent(r, 'p' + i);
    expect(r.length).toBe(8); expect(r[0]).toBe('p9');
    expect(pushRecent(r, 'p5')[0]).toBe('p5'); expect(pushRecent(r, 'p5').length).toBe(8);
  });
  it('applying a preset then changing size makes the style custom', () => {
    const d = { footage: {}, captions: { on: true, lines: [], style: null, preset: null, source: 'speech', styleFrom: 'look' } };
    applyPresetTo(d, 'viral-impact');
    expect(d.captions.preset).toBe('viral-impact');
    expect(d.captions.styleFrom).toBeFalsy();
    expect(d.captions.style.anim).toBe('pop');
    editStyle(d, { size: 0.09 });
    expect(d.captions.preset).toBe(null);
    expect(d.captions.styleFrom).toBe('custom');
    expect(d.captions.style.size).toBe(0.09);
    applyBrandStyle(d, { size: 0.05 }, 'look');
    expect(d.captions.preset).toBe(null); expect(d.captions.styleFrom).toBe('look');
  });
});

describe('Styles panel: language, removal, label', () => {
  const ar = ln('a', 'مرحبا بكم'), en = ln('b', 'hello there');
  it('langFromLines and captionLang', () => {
    expect(langFromLines([en, ar])).toBe('ar'); expect(langFromLines([en])).toBe('en'); expect(langFromLines([])).toBe(null);
    expect(captionLang({ footage: {}, captions: { lang: null, lines: [ar] } })).toBe('ar');
    expect(captionLang({ footage: {}, captions: { lang: 'en', lines: [ar] } })).toBe('en');
    expect(captionLang({ footage: {}, captions: { lang: 'ar-TN', lines: [] } })).toBe('ar');
    expect(captionLang({ footage: {}, captions: { lang: null, lines: [] } })).toBe('en');
  });
  it('removeBrandStyle drops one by id', () => {
    expect(removeBrandStyle([{ id: 'a' }, { id: 'b' }], 'a')).toEqual([{ id: 'b' }]);
    expect(removeBrandStyle(undefined, 'a')).toEqual([]);
  });
  it('styleLabel shows Custom only for a custom style', () => {
    expect(styleLabel({ preset: 'viral-impact' })).toBe('Impact');
    expect(styleLabel({ preset: 'bs:1' }, () => 'Mine')).toBe('Mine');
    expect(styleLabel({ preset: null, styleFrom: 'custom', style: {} })).toBe('Custom');
    expect(styleLabel({ styleFrom: 'reference', style: {} })).toBe('Reference');
    expect(styleLabel({ styleFrom: 'look', style: {} })).toBe('Brand look');
    expect(styleLabel({ style: null })).toBe('Default');
  });
  it('applyBrandStyle marks the applied card', () => {
    const d = { footage: {}, captions: { lines: [] } }; applyBrandStyle(d, { size: 0.05 }, 'custom', 'bs:1');
    expect(d.captions.preset).toBe('bs:1');
  });
});

/* ---------- caption inspector (caption-inspector.js) ---------- */
import { setStyleField, INSPECTOR_TABS, regroupFrom, wordsOfLines, pollFailure, REF_GONE, REF_FAILED, hex6, alphaOf, captionHit } from './caption-inspector.js';
import { DEFAULT_STYLE as DS } from './captions.js';

describe('caption inspector', () => {
  it('tabs follow the Global Constraints order', () => {
    expect(INSPECTOR_TABS.map((t) => t[1])).toEqual(['Font', 'Colors', 'Spacing', 'Layout', 'Box', 'Animate', 'Timing', 'Reference']);
    expect(new Set(INSPECTOR_TABS.map((t) => t[0])).size).toBe(8);
  });
  it('setStyleField clamps each numeric field', () => {
    const c = (path, v) => { const s = setStyleField(DS, path, v); return path.split('.').reduce((o, k) => o[k], s); };
    expect(c('size', 0.5)).toBe(0.12); expect(c('size', 0)).toBe(0.02); expect(c('size', 0.05)).toBe(0.05);
    expect(c('ls', -1)).toBe(-0.05); expect(c('ls', 1)).toBe(0.3); expect(c('ls', 0.1)).toBe(0.1);
    expect(c('lh', 0.2)).toBe(0.9); expect(c('lh', 9)).toBe(2); expect(c('lh', 1.3)).toBe(1.3);
    expect(c('x', -0.5)).toBe(0); expect(c('x', 2)).toBe(1); expect(c('y', -1)).toBe(0); expect(c('y', 1.5)).toBe(1); expect(c('y', 0.4)).toBe(0.4);
    expect(c('offset', -5000)).toBe(-1000); expect(c('offset', 5000)).toBe(1000); expect(c('offset', 250)).toBe(250);
    expect(c('animSpeed', 0.1)).toBe(0.5); expect(c('animSpeed', 9)).toBe(2); expect(c('animSpeed', 1.5)).toBe(1.5);
  });
  it('setStyleField returns a new object and never touches the input', () => {
    const before = JSON.stringify(DS), s = setStyleField(DS, 'stroke.color', '#ff0000');
    expect(s).not.toBe(DS); expect(JSON.stringify(DS)).toBe(before);
    expect(s.stroke).toEqual({ color: '#ff0000', width: 0.004 });
    const h = setStyleField(DS, 'highlight.color', '#00ff00'); expect(h.highlight).not.toBe(DS.highlight); expect(DS.highlight.color).toBe('#E8B54A');
    expect(setStyleField(null, 'size', 0.05).size).toBe(0.05);
  });
  it('setStyleField ignores unusable values and unknown fields', () => {
    expect(setStyleField(DS, 'size', 'x').size).toBe(DS.size);
    expect(setStyleField(DS, 'font', 'comic').font).toBe(DS.font);
    expect(setStyleField(DS, 'anim', 'spin').anim).toBe(DS.anim);
    expect(setStyleField(DS, 'anim', 'typewriter').anim).toBe('typewriter');
    expect(setStyleField(DS, 'color', 'red').color).toBe(DS.color);
    expect(setStyleField(DS, 'nope', 1)).toEqual(DS);
    expect(setStyleField(DS, 'box', true).box).toEqual({ color: '#000000', pad: 0.012, radius: 0.18 });
    expect(setStyleField({ ...DS, box: { color: '#111111' } }, 'box', false).box).toBeNull();
    expect(setStyleField(DS, 'maxWords', 20).maxWords).toBe(8);
    expect(setStyleField(DS, 'case', 'upper').case).toBe('upper');
    expect(setStyleField(DS, 'align', 'left').align).toBe('left');
  });
  it('stroke and shadow switch on with defaults and keep their values while on (moved from styleEdit)', () => {
    const on = setStyleField(DS, 'stroke', true); expect(on.stroke).toEqual({ color: '#000000', width: 0.004 });
    const w = setStyleField(on, 'stroke.width', 0.012); expect(w.stroke).toEqual({ color: '#000000', width: 0.012 });
    expect(setStyleField(w, 'stroke.width', 1).stroke.width).toBe(0.02);
    expect(setStyleField(w, 'stroke', true).stroke).toEqual(w.stroke);
    expect(setStyleField(w, 'stroke', false).stroke).toBeNull();
    expect(setStyleField(DS, 'shadow', false).shadow).toBeNull(); expect(setStyleField(setStyleField(DS, 'shadow', false), 'shadow', true).shadow).toEqual(DS.shadow);
  });
  it('highlight: mode and colours; none keeps the colours for later (moved from styleEdit)', () => {
    const a = setStyleField(DS, 'highlight.color', '#00ff00'); expect(a.highlight).toEqual({ ...DS.highlight, color: '#00ff00' });
    const b = setStyleField(a, 'highlight.mode', 'none'); expect(b.highlight.mode).toBe('none'); expect(b.highlight.color).toBe('#00ff00');
    expect(setStyleField(b, 'highlight.mode', 'glow').highlight.mode).toBe('none');
    expect(setStyleField({ ...DS, highlight: null }, 'highlight.mode', 'scale').highlight).toEqual({ ...DS.highlight, mode: 'scale' });
    expect(setStyleField(DS, 'weight', '700').weight).toBe(700); expect(setStyleField(DS, 'weight', 50).weight).toBe(DS.weight);
  });
  it('a translucent colour keeps its opacity when its colour is edited', () => {
    expect(DS.shadow.color).toBe('rgba(0,0,0,.55)');
    expect(setStyleField(DS, 'shadow.color', '#ff0000').shadow.color).toBe('rgba(255,0,0,0.55)');
    expect(setStyleField(DS, 'color', '#abcdef').color).toBe('#abcdef'); // an opaque colour stays hex
    expect(alphaOf('rgba(0,0,0,.55)')).toBe(0.55); expect(alphaOf('#000')).toBe(1);
    expect(hex6('rgba(0,0,0,.55)')).toBe('#000000'); expect(hex6('rgb(255, 16, 1)')).toBe('#ff1001'); expect(hex6('#ABC')).toBe('#aabbcc'); expect(hex6('red', '#123456')).toBe('#123456');
  });
  it('pollFailure: a 404 stops at once, other errors after 3 in a row', () => {
    expect(pollFailure(0, { status: 404 })).toEqual({ stop: true, fails: 1, msg: REF_GONE });
    expect(pollFailure(0, { status: 500 })).toEqual({ stop: false, fails: 1 });
    expect(pollFailure(1, new Error('net'))).toEqual({ stop: false, fails: 2 });
    expect(pollFailure(2, { status: 502 })).toEqual({ stop: true, fails: 3, msg: REF_FAILED });
  });
  it('captionHit: on the caption block, with a margin', () => {
    const L = { x: 300, y: 600, w: 400, h: 50 };
    expect(captionHit(L, 1000, 1000, 0.5, 0.62)).toBe(true);
    expect(captionHit(L, 1000, 1000, 0.29, 0.6)).toBe(true); // inside the 2.5 % margin
    expect(captionHit(L, 1000, 1000, 0.5, 0.3)).toBe(false);
    expect(captionHit(null, 1000, 1000, 0.5, 0.62)).toBe(false);
  });
  it('regroupFrom picks where the words come from', () => {
    expect(regroupFrom('video', { source: 'speech' })).toBe('speech');
    expect(regroupFrom('video', { source: null })).toBe('speech');
    expect(regroupFrom('video', { source: 'manual' })).toBe('lines');
    expect(regroupFrom('reel', { source: 'voiceover' })).toBe('voiceover');
    expect(regroupFrom('reel', {})).toBe('voiceover');
    expect(regroupFrom('reel', { source: 'srt' })).toBe('lines');
  });
  it('wordsOfLines flattens the lines in time order', () => {
    expect(wordsOfLines([ln('b', 'c d', 2000), ln('a', 'a b', 0)]).map((w) => w.t)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('Script panel', () => {
  const vid = () => ({ name: 'My clip!', footage: { src: 'f1' }, captions: { on: true, lines: [ln('a', 'old line')], style: null, source: 'speech' } });
  const sp = (t) => t.split(' ').map((w, k) => ({ t: w, s: k * 300, e: k * 300 + 250 }));
  it('a script that matches the speech has no note', () => {
    const r = scriptAction(vid(), 'hello there my friend', sp('hello there my friend'), 5000);
    expect(r.note).toBeNull(); expect(words(r.lines)).toEqual(['hello', 'there', 'my', 'friend']);
  });
  it('a script that does not match the speech is spread, with the note', () => {
    const r = scriptAction(vid(), 'one two three four five six', sp('zzz yyy xxx www'), 6000);
    expect(r.note).toBe(SPREAD_NOTE); expect(words(r.lines)).toHaveLength(6);
    expect(r.lines[r.lines.length - 1].end).toBeLessThanOrEqual(6000);
  });
  it('no note when there was no speech', () => {
    expect(scriptAction(vid(), 'one two three', [], 3000).note).toBeNull();
  });
  it('pending speech gives its own note, the 40 percent note stays', () => {
    expect(scriptAction(vid(), 'one two three', [], 3000, 'pending').note).toBe(PENDING_NOTE);
    expect(scriptAction(vid(), 'one two three', [], 3000, 'none').note).toBeNull();
    expect(scriptAction(vid(), 'one two three four five six', sp('zzz yyy xxx www'), 3000, 'pending').note).toBe(SPREAD_NOTE);
  });
  it('a bad SRT leaves the lines identical', () => {
    const d = vid(), before = JSON.parse(JSON.stringify(capsOf15(d)));
    const r = applySrt(d, 'not a subtitle file');
    expect(r).toEqual({ ok: false, error: 'This file has no readable captions' });
    expect(capsOf15(d)).toEqual(before);
  });
  it('a good SRT replaces the lines with source srt', () => {
    const d = vid(), r = applySrt(d, '1\n00:00:01,000 --> 00:00:02,000\nHi there\n');
    expect(r.ok).toBe(true); expect(capsOf15(d).source).toBe('srt'); expect(words(capsOf15(d).lines)).toEqual(['Hi', 'there']);
  });
  it('a script sets source script', () => {
    const d = vid(); setLines(d, scriptAction(d, 'abc def', [], 2000).lines, 'script');
    expect(capsOf15(d).source).toBe('script');
  });
  it('a reel keeps script / srt lines with their source and voSig', () => {
    const d = reel();
    setLines(d, [ln('x', 'hi there')], 'script');
    expect(capsOf15(d).source).toBe('script'); expect(capsOf15(d).voSig).toBe(voSig(d.pages)); expect(linesOf(d).map((l) => l.id)).toEqual(['x']);
    expect(applySrt(d, '1\n00:00:00,000 --> 00:00:01,000\nYo\n').ok).toBe(true);
    expect(capsOf15(d).source).toBe('srt'); expect(capsOf15(d).voSig).toBe(voSig(d.pages)); expect(words(linesOf(d))).toEqual(['Yo']);
  });
  it('decodes UTF-8, and Windows-1256 when UTF-8 breaks', () => {
    expect(decodeSubtitleBytes(new TextEncoder().encode('مرحبا'))).toBe('مرحبا');
    expect(decodeSubtitleBytes(new Uint8Array([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]))).toBe('مرحبا');
  });
  it('file base is the safe design name', () => { expect(fileBase({ name: 'My clip!' })).toBe('My-clip'); expect(fileBase({})).toBe('video'); });
});
