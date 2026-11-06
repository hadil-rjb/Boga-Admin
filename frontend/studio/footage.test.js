import { describe, it, expect, vi } from 'vitest';
import { blockSchedule, isFootageDesign, SCHEDULE_VIDEO, closeAction, READY_IN_STUDIO, UPLOAD_STOPPED } from './footage.js';

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
