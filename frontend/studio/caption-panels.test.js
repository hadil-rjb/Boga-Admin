import { describe, it, expect } from 'vitest';
import { filterRows, fold, reelCaptions, linesOf, capsView, toggleCaptions, editCaptions, rebuildFromVoiceover, prepareReel, hasVoiceover, captionsOn, captionFrame } from './caption-panels.js';
import { needsRebuild, voSig } from './caption-sources.js';

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
