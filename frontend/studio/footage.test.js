import { describe, it, expect, vi } from 'vitest';
import { blockSchedule, isFootageDesign, SCHEDULE_VIDEO, closeAction, READY_IN_STUDIO, UPLOAD_STOPPED, canStart } from './footage.js';

describe('schedule guard', () => {
  it('refuses a footage design with the exact message, lets other designs through', () => {
    const toast = vi.fn();
    expect(blockSchedule({ id: 'd1', footage: { src: 'a' } }, toast)).toBe(true);
    expect(toast).toHaveBeenCalledWith("Scheduling videos isn't available yet. Download the video and post it from your phone.");
    expect(SCHEDULE_VIDEO).toBe("Scheduling videos isn't available yet. Download the video and post it from your phone.");
    toast.mockClear();
    expect(blockSchedule({ id: 'd2', pages: [] }, toast)).toBe(false);
    expect(blockSchedule(null, toast)).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(isFootageDesign({ footage: {} })).toBe(true); expect(isFootageDesign({})).toBe(false);
  });
});

describe('closing the upload modal', () => {
  it('stops only while uploads are running; once both are complete the design is still created', () => {
    expect(closeAction({ busy: false, uploaded: false })).toBe('none');
    expect(closeAction({ busy: true, uploaded: false })).toBe('stop');
    expect(closeAction({ busy: true, uploaded: true })).toBe('finish');
  });
  it('copy', () => {
    expect(READY_IN_STUDIO).toBe('Your video is ready in Studio.');
    expect(UPLOAD_STOPPED).toBe('Upload stopped. Drop the same files again to pick up where you left off.');
  });
});

describe('upload modal Start', () => {
  it('needs only an original', () => {
    expect(canStart({ busy: false, original: null })).toBe(false);
    expect(canStart({ busy: false, original: {} })).toBe(true);
    expect(canStart({ busy: false, original: {}, ref: {} })).toBe(true);
    expect(canStart({ busy: true, original: {} })).toBe(false);
  });
});

import { videoBlank, lengthError, TOO_LONG, MAX_SEC, REPLACE_ASK, NO_GRADE_YET } from './footage.js';
import { kindOf } from './caption-store.js';

describe('Caption a video: a blank video design', () => {
  it('is a video with no footage yet and empty captions', () => {
    const d = videoBlank();
    expect(kindOf(d)).toBe('video');
    expect(d.footage.src).toBe(null);
    expect(d.footage.ref).toBe(null);
    expect(d.footage.lookId).toBe(null);
    expect(d.captions.lines).toEqual([]);
    expect(videoBlank().footage).not.toBe(d.footage); // a fresh object each time
  });
});

describe('the 10-minute limit', () => {
  it('refuses a video over 10 minutes (probe seconds) with the exact message', () => {
    expect(TOO_LONG).toBe('This video is longer than 10 minutes.');
    expect(MAX_SEC).toBe(600);
    expect(lengthError(601)).toBe('This video is longer than 10 minutes.');
    expect(lengthError(600)).toBe(null);
    expect(lengthError(12.5)).toBe(null);
    expect(lengthError(null)).toBe(null); // unknown length: the upload goes on, the probe checks again
    expect(lengthError(NaN)).toBe(null);
  });
  it('copy', () => {
    expect(REPLACE_ASK).toBe('Replace this video? Captions will be made again from the new video.');
    expect(NO_GRADE_YET).toBe('No colour grade yet. Match a reference or apply a brand look.');
  });
});

import { ownsUpload } from './footage.js';
describe('an upload acts on its design only while it owns it', () => {
  it('stopped or replaced uploads never commit', () => {
    const map = new Map(), st = { ac: new AbortController() }, other = { ac: new AbortController() };
    map.set('d1', st);
    expect(ownsUpload(map, 'd1', st)).toBe(true);
    map.set('d1', other); expect(ownsUpload(map, 'd1', st)).toBe(false); // a newer upload replaced it
    map.set('d1', st); st.ac.abort(); expect(ownsUpload(map, 'd1', st)).toBe(false); // Stop
    map.delete('d1'); expect(ownsUpload(map, 'd1', other)).toBe(false);
    expect(ownsUpload(map, 'd1', null)).toBe(false);
  });
});
