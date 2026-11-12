import { describe, expect, it } from 'vitest';
import * as MO from './motion.js';
import { agentMode, allowed, animPatch, fitAnims, scenePatch, animOut, videoCtx, frameTime, starterFor, sec, agentCopy, videoStep } from './agent-motion.js';

describe('agentMode', () => {
  it('follows the kind and the editor mode', () => {
    expect(agentMode('still', 'design')).toBe('design');
    expect(agentMode('reel', 'design')).toBe('design');
    expect(agentMode('reel', 'animate')).toBe('animate');
    expect(agentMode('video', 'animate')).toBe('video');
  });
});
describe('allowed', () => {
  it('keeps each mode to its own tools', () => {
    expect(allowed('manage_slides', 'animate')).toBe(false);
    expect(allowed('make_video', 'animate')).toBe(false);
    expect(allowed('animate_layers', 'design')).toBe(false);
    expect(allowed('view_frame', 'design')).toBe(false);
    ['update_layers', 'view_slide', 'check_design'].forEach((t) => { expect(allowed(t, 'design')).toBe(true); expect(allowed(t, 'animate')).toBe(true); });
  });
});
describe('allowed in video', () => {
  it('keeps the video tools to the video mode, and the layer tools out of it', () => {
    ['set_grade', 'set_audio'].forEach((t) => { expect(allowed(t, 'video')).toBe(true); expect(allowed(t, 'design')).toBe(false); expect(allowed(t, 'animate')).toBe(false); });
    ['edit_captions', 'read_captions', 'style_captions'].forEach((t) => { expect(allowed(t, 'video')).toBe(true); expect(allowed(t, 'design')).toBe(false); });
    ['update_layers', 'add_layers', 'manage_slides', 'animate_layers', 'make_video', 'check_design', 'view_slide'].forEach((t) => expect(allowed(t, 'video')).toBe(false));
    ['view_frame', 'write_caption', 'rename_design', 'read_planner', 'propose_schedule', 'propose_automation'].forEach((t) => expect(allowed(t, 'video')).toBe(true));
  });
});
describe('allowed in animate (sound)', () => {
it('gives animate the sound and caption tools', () => {
  ['write_voiceover', 'make_voices', 'set_voice', 'remove_voice', 'set_music', 'read_captions', 'edit_captions', 'style_captions'].forEach((t) => expect(allowed(t, 'animate')).toBe(true));
  ['write_voiceover', 'set_music'].forEach((t) => { expect(allowed(t, 'design')).toBe(false); expect(allowed(t, 'video')).toBe(false); });
  ['set_grade', 'set_audio'].forEach((t) => expect(allowed(t, 'animate')).toBe(false));
});
});
describe('animPatch', () => {
  const L = { id: 'a', anim: { in: 'fade', d: 200, t: 600, e: 'smooth', out: 'none', ot: 450, loop: 'none' } };
  it('maps names and seconds, and keeps what was not given', () => {
    const { anim, notes } = animPatch(L, { enter: 'rise', delay: 0.5 }, 3000);
    expect(anim).toEqual({ in: 'rise', d: 500, t: 600, e: 'smooth', out: 'none', ot: 450, loop: 'none' });
    expect(notes).toEqual([]);
  });
  it('does not touch the layer it reads', () => { animPatch(L, { enter: 'pop', delay: 1 }, 3000); expect(L.anim.in).toBe('fade'); expect(L.anim.d).toBe(200); });
  it('starts from the defaults on a layer with no animation', () => {
    expect(animPatch({ id: 'b' }, { enter: 'pop' }, 3000).anim).toEqual({ ...MO.ANIM_DEFAULT, in: 'pop' });
  });
  it('clamps the duration to the scene, then the delay to what is left', () => {
    const { anim, notes } = animPatch(L, { delay: 9, duration: 2 }, 3000);
    expect(anim.t).toBe(2000); expect(anim.d).toBe(1000);
    expect(notes.join(' ')).toMatch(/delay/);
  });
  it('clamps the lower bounds', () => {
    const { anim } = animPatch(L, { delay: -1, duration: 0, exitDuration: 0 }, 3000);
    expect([anim.d, anim.t, anim.ot]).toEqual([0, 100, 100]);
  });
  it('rejects unknown presets and names the valid ones', () => {
    const { anim, notes } = animPatch(L, { enter: 'teleport', ease: 'nope' }, 3000);
    expect(anim.in).toBe('fade'); expect(anim.e).toBe('smooth');
    expect(notes[0]).toContain('teleport'); expect(notes[0]).toContain('rise');
    expect(notes[1]).toContain('nope');
  });
  it('ignores values that are not numbers', () => { expect(animPatch(L, { delay: 'soon' }, 3000).anim.d).toBe(200); });
  it('takes no input as no change', () => { expect(animPatch(L, undefined, 3000).anim).toEqual(L.anim); });
});
describe('fitAnims', () => {
  it('pulls timings inside a shorter scene and counts the layers it changed', () => {
    const ls = [{ anim: { ...MO.ANIM_DEFAULT, d: 2500, t: 700 } }, { anim: { ...MO.ANIM_DEFAULT, d: 100, t: 300 } }, {}];
    expect(fitAnims(ls, 1000)).toBe(1);
    expect(ls[0].anim.t).toBe(700); expect(ls[0].anim.d).toBe(300);
    expect(ls[2].anim).toBeUndefined();
  });
});
describe('scenePatch', () => {
  const S = { k: 'body', dur: 3000, tr: 'fade', trd: 500 };
  it('sets length, transition and role', () => {
    expect(scenePatch(S, { seconds: 4.5, transition: 'zoom', transitionSeconds: 0.8, role: 'outro' }, false).scene).toEqual({ k: 'outro', dur: 4500, tr: 'zoom', trd: 800 });
  });
  it('clamps the length to 0.5–60 s and the transition to half the scene', () => {
    expect(scenePatch(S, { seconds: 0.1 }, false).scene.dur).toBe(500);
    expect(scenePatch(S, { seconds: 600 }, false).scene.dur).toBe(60000);
    const r = scenePatch(S, { seconds: 1, transitionSeconds: 5 }, false);
    expect(r.scene.trd).toBe(500); expect(r.notes.length).toBeGreaterThan(0);
  });
  it('gives the first scene no transition', () => {
    const r = scenePatch({ ...S, tr: 'cut' }, { transition: 'zoom' }, true);
    expect(r.scene.tr).toBe('cut'); expect(r.notes[0]).toMatch(/first scene/i);
  });
  it('rejects an unknown transition or role', () => {
    const r = scenePatch(S, { transition: 'spin', role: 'middle' }, false);
    expect(r.scene).toEqual(S); expect(r.notes).toHaveLength(2);
  });
});
describe('animOut', () => {
  it('hides a layer with no entrance, exit or loop', () => {
    expect(animOut({})).toBeUndefined();
    expect(animOut({ anim: { ...MO.ANIM_DEFAULT, in: 'none' } })).toBeUndefined();
  });
  it('shows the model its own field names, in seconds', () => {
    expect(animOut({ anim: { in: 'rise', d: 250, t: 700, e: 'smooth', out: 'fade', ot: 450, loop: 'none' } }))
      .toEqual({ enter: 'rise', delay: 0.3, duration: 0.7, ease: 'smooth', exit: 'fade', exitDuration: 0.5, loop: 'none' });
  });
});
describe('videoCtx', () => {
  const pages = [{ scene: { k: 'intro', dur: 2000, tr: 'cut', trd: 500 }, layers: [] }, { scene: { k: 'body', dur: 3500, tr: 'fade', trd: 500 }, layers: [] }];
  it("lists the scenes with the timeline's own starts and total", () => {
    const v = videoCtx(pages, 30), tl = MO.timeline(pages);
    expect(v.fps).toBe(30); expect(v.seconds).toBe(sec(tl.total));
    expect(v.scenes.map((s) => s.number)).toEqual([1, 2]);
    expect(v.scenes[1]).toEqual({ number: 2, role: 'body', start: sec(tl.scenes[1].start), seconds: 3.5, transition: 'fade', transitionSeconds: 0.5 });
  });
});
describe('frameTime', () => {
  const tl = MO.timeline([{ scene: { k: 'body', dur: 2000, tr: 'cut', trd: 0 }, layers: [] }, { scene: { k: 'body', dur: 4000, tr: 'cut', trd: 0 }, layers: [] }]);
  it('defaults to 60 % into the current scene', () => { expect(frameTime(tl, {}, 1)).toEqual({ ms: tl.scenes[1].start + 2400, scene: 2, offsetMs: 2400 }); });
  it('takes a time from the start of the video', () => { const f = frameTime(tl, { at: 1 }, 1); expect(f.ms).toBe(1000); expect(f.scene).toBe(1); expect(f.offsetMs).toBe(1000); });
  it('takes a scene and an offset, kept inside the scene', () => {
    expect(frameTime(tl, { scene: 2, offset: 1 }, 0).ms).toBe(tl.scenes[1].start + 1000);
    expect(frameTime(tl, { scene: 1, offset: 99 }, 0).offsetMs).toBe(1999);
  });
  it('clamps a time outside the video', () => {
    expect(frameTime(tl, { at: -3 }, 0).ms).toBe(0);
    expect(frameTime(tl, { at: 999 }, 0).ms).toBe(tl.total - 1);
  });
  it('refuses a scene that does not exist', () => { expect(() => frameTime(tl, { scene: 7 }, 0)).toThrow('There is no scene 7'); });
});
describe('starterFor', () => {
  it('defaults to a blank body scene', () => { expect(starterFor()).toEqual({ role: 'body', key: 'blank' }); });
  it('accepts a starter of its role', () => { expect(starterFor('intro', 'title')).toEqual({ role: 'intro', key: 'title' }); });
  it('names the valid starters on a miss', () => { expect(() => starterFor('intro', 'nope')).toThrow(/title/); });
  it('refuses an unknown role', () => { expect(() => starterFor('middle')).toThrow(/intro, body, outro/); });
});
describe('agentCopy', () => {
  it('speaks of slides in design and scenes in animate', () => {
    expect(agentCopy('design', 1, 5, 'slide').sub).toBe('Edits slide 2 of 5');
    expect(agentCopy('animate', 1, 5, 'slide').sub).toBe('Edits scene 2 of 5');
    expect(agentCopy('design', 1, 5, 'slide').chip).toBe('Slide 2');
    expect(agentCopy('design', 1, 5, 'all').chip).toBe('All 5 slides');
    expect(agentCopy('animate', 1, 5, 'all').chip).toBe('All 5 scenes');
    expect(agentCopy('animate', 1, 5, 'slide').chip).toBe('Scene 2');
  });
  it('offers the three animation prompts in animate only', () => {
    expect(agentCopy('animate', 0, 1, 'slide').prompts.map((p) => p[1])).toEqual(['Animate this scene', 'Animate every scene', 'Add an intro and an outro']);
    expect(agentCopy('design', 0, 1, 'slide').prompts).toEqual([]);
  });
  it('asks for animation changes in animate', () => {
    expect(agentCopy('animate', 0, 1, 'slide').placeholder).toBe('Ask for animation changes');
    expect(agentCopy('design', 0, 1, 'slide').placeholder).toBe('Ask for changes');
  });
  it('keeps today\'s empty state in design', () => { expect(agentCopy('design', 0, 1, 'slide').empty).toBe(''); expect(agentCopy('animate', 0, 1, 'slide').empty).toMatch(/^Describe the motion you want/); });
});
describe('videoStep', () => {
  it('converts a still, switches a video shown in Design mode, refuses the rest', () => {
    expect(videoStep('still', 'design')).toBe('convert');
    expect(videoStep('reel', 'design')).toBe('switch');
    expect(videoStep('reel', 'animate')).toBe('none');
    expect(videoStep('video', 'animate')).toBe('none');
  });
});
describe('agentCopy in video', () => {
  it('speaks of the video in video mode', () => {
    const c = agentCopy('video', 0, 1, 'slide');
    expect(c.sub).toBe('Edits this video'); expect(c.chip).toBe('Whole video'); expect(c.placeholder).toBe('Ask for caption, colour or sound changes');
    expect(c.prompts.map((p) => p[1])).toEqual(['Fix the captions', 'Make the captions pop', 'Add calm music']);
    expect(c.empty).toBe('Describe what to change: caption text and style, colours, sound. I edit the video for you.');
  });
});
