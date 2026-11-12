import { describe, expect, it } from 'vitest';
import { planRecovery } from './footage.recovery';

const now = Date.parse('2026-11-04T12:00:00Z'), min = 60_000;
const rec = (o: any) => ({ _id: 'a'.repeat(24), status: 'processing', jobs: {}, updatedAt: new Date(now - min), ...o });

describe('planRecovery', () => {
  it('assembling older than 10 minutes goes back to uploading', () => {
    expect(planRecovery([rec({ status: 'assembling', updatedAt: new Date(now - 11 * min) })], now)).toEqual({ reset: ['a'.repeat(24)], requeue: [] });
  });
  it('recent assembling is left alone (the request may still be running)', () => {
    expect(planRecovery([rec({ status: 'assembling', updatedAt: new Date(now - 2 * min) })], now)).toEqual({ reset: [], requeue: [] });
  });
  it('a running or queued step is re-enqueued from that step', () => {
    const id = 'b'.repeat(24);
    expect(planRecovery([rec({ _id: id, jobs: { probe: { state: 'done' }, proxy: { state: 'running', progress: 0.4 } } })], now).requeue).toEqual([{ id, step: 'proxy' }]);
    expect(planRecovery([rec({ _id: id, jobs: { probe: { state: 'queued' } } })], now).requeue).toEqual([{ id, step: 'probe' }]);
  });
  it('picks the earliest unfinished step in chain order', () => {
    const id = 'c'.repeat(24);
    expect(planRecovery([rec({ _id: id, jobs: { frames: { state: 'queued' }, proxy: { state: 'running' } } })], now).requeue).toEqual([{ id, step: 'proxy' }]);
  });
  it('ignores failed, ready and fully done records', () => {
    expect(planRecovery([rec({ status: 'failed', jobs: { proxy: { state: 'running' } } }), rec({ status: 'ready', jobs: { frames: { state: 'done' } } }), rec({ jobs: { probe: { state: 'done' } } })], now)).toEqual({ reset: [], requeue: [] });
  });
});
