import { describe, expect, it } from 'vitest';
import { voiceoverLines, scenesToVoice, voiceInput, musicInput, soundCtx } from './agent-sound.js';

const P = () => [
  { scene: { dur: 3000, vo: { text: 'One', src: 's1', dur: 1200, srcText: 'One' } } },
  { scene: { dur: 3000, vo: { text: 'Two new', src: 's2', dur: 1500, srcText: 'Two' } } },
  { scene: { dur: 3000, vo: { text: 'Three' } } },
  { scene: { dur: 3000 } },
];
describe('voiceoverLines', () => {
  it('maps scene numbers to indexes, clips text, names unknown scenes', () => {
    const r = voiceoverLines(P(), [{ scene: 4, text: 'Four' }, { scene: 9, text: 'x' }, { scene: 1, text: 'a'.repeat(700) }]);
    expect(r.set.map((s) => s.i)).toEqual([3, 0]); expect(r.set[1].text).toHaveLength(600); expect(r.notes[0]).toMatch(/scene 9/);
  });
  it('refuses empty text', () => { expect(voiceoverLines(P(), [{ scene: 1, text: '  ' }]).notes[0]).toMatch(/empty/); });
});
describe('scenesToVoice', () => {
  it('defaults to text with no clip or changed text', () => { expect(scenesToVoice(P())).toEqual([1, 2]); });
  it('takes the listed scenes that have text', () => { expect(scenesToVoice(P(), [1, 4, 7])).toEqual([0]); });
});
describe('voiceInput', () => {
  const ctx = { voices: [{ id: 'af_heart', name: 'Heart' }], languages: ['English', 'Arabic'] };
  it('sets voice, clamped speed and language', () => {
    expect(voiceInput({}, { voice: 'af_heart', speed: 2, language: 'Arabic' }, ctx)).toEqual({ patch: { voice: 'af_heart', speed: 1.3, language: 'Arabic' }, notes: ['speed clamped to 1.3'] });
  });
  it('names unknown voices and languages', () => {
    const r = voiceInput({}, { voice: 'zz', language: 'Klingon' }, ctx);
    expect(r.patch).toEqual({}); expect(r.notes.join(' ')).toMatch(/af_heart/); expect(r.notes.join(' ')).toMatch(/English, Arabic/);
  });
});
describe('musicInput', () => {
  const M = { src: 'm', name: 'Chill', vol: 0.35 };
  it('sets volume, fades and ducking; removes', () => {
    expect(musicInput(M, { volume: 20, fadeIn: false, ducking: true }).music).toEqual({ ...M, vol: 0.2, fadeIn: false });
    expect(musicInput(M, { remove: true }).music).toBe(null);
  });
  it('composes by mood and refuses settings with no music', () => {
    expect(musicInput(null, { compose: 'upbeat', volume: 30 }).compose).toBe('upbeat');
    expect(musicInput(null, { volume: 30 }).notes[0]).toMatch(/no music/i);
    expect(musicInput(M, { compose: 'jazz' }).notes[0]).toMatch(/upbeat, chill, corporate, cinematic/);
  });
});
describe('soundCtx', () => {
  it('summarises the voice-over, the voice, the music and the captions', () => {
    const v = soundCtx({ pages: P(), audio: { speed: 1, duck: true, music: { name: 'Chill', vol: 0.35 } }, voices: [{ id: 'af_heart', name: 'Heart' }], ready: true, voiceId: 'af_heart', voiceName: 'Heart', language: 'English', caps: { on: true, source: 'manual', preset: 'karaoke-gold' } });
    expect(v.scenes[1]).toEqual({ number: 2, text: 'Two new', voiced: true, voiceSeconds: 1.5, needsVoice: true });
    expect(v.scenes[3]).toEqual({ number: 4, text: '', voiced: false, voiceSeconds: 0, needsVoice: false });
    expect(v.music).toEqual({ name: 'Chill', volume: 35, fadeIn: true, fadeOut: true, ducking: true });
    expect(v.captions).toEqual({ on: true, from: 'manual', preset: 'karaoke-gold' });
    expect(v.voice).toEqual({ id: 'af_heart', name: 'Heart', language: 'English', speed: 1 });
  });
});
