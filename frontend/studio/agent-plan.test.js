import { describe, expect, it } from 'vitest';
import { checkSchedule, checkAutomation, plannerView, cadenceWords, cardLines, freeSlot, upcomingTimes } from './agent-plan.js';

const ctx = { connected: ['ig', 'li'], now: { date: '2026-11-12', time: '15:40' }, nextFreeSlot: { date: '2026-11-13', time: '12:30' }, blocked: null };
describe('checkSchedule', () => {
  it('accepts a well formed proposal', () => {
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-13', time: '09:00', caption: 'Hi' }, ctx).value).toEqual({ networks: ['ig'], date: '2026-11-13', time: '09:00', caption: 'Hi', firstComment: '' });
  });
  it('falls back to the next free slot when no date and no time are given', () => {
    const v = checkSchedule({ networks: ['ig'] }, ctx).value; expect([v.date, v.time]).toEqual(['2026-11-13', '12:30']);
  });
  it('asks for the missing half', () => { expect(checkSchedule({ networks: ['ig'], date: '2026-11-13' }, ctx).error).toMatch(/time/); });
  it('refuses networks that are unknown or not connected, naming the connected ones', () => {
    expect(checkSchedule({ networks: ['myspace'], date: '2026-11-13', time: '09:00' }, ctx).error).toMatch(/myspace/);
    expect(checkSchedule({ networks: ['x'], date: '2026-11-13', time: '09:00' }, ctx).error).toMatch(/ig, li/);
    expect(checkSchedule({ networks: [], date: '2026-11-13', time: '09:00' }, ctx).error).toMatch(/network/);
  });
  it('says so when nothing is connected', () => { expect(checkSchedule({ networks: ['ig'] }, { ...ctx, connected: [] }).error).toBe('No network is connected. Connect one in Settings → Connected accounts.'); });
  it('refuses a malformed date or time', () => {
    expect(checkSchedule({ networks: ['ig'], date: '13/11/2026', time: '09:00' }, ctx).error).toMatch(/date/);
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-13', time: '9am' }, ctx).error).toMatch(/time/);
    expect(checkSchedule({ networks: ['ig'], date: '2026-02-30', time: '09:00' }, ctx).error).toMatch(/date/);
  });
  it('refuses a moment past in the workspace zone, and accepts one a minute ahead', () => {
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-12', time: '15:39' }, ctx).error).toMatch(/past/);
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-12', time: '15:41' }, ctx).value).toBeTruthy();
    expect(checkSchedule({ networks: ['ig'], date: '2026-11-11', time: '23:00' }, ctx).error).toMatch(/past/);
  });
  it('refuses what the editor blocks (an uploaded video with no clip)', () => { expect(checkSchedule({ networks: ['ig'] }, { ...ctx, blocked: 'Add your video first, then schedule it.' }).error).toBe('Add your video first, then schedule it.'); });
  it('clips the caption and the first comment, and de-duplicates networks', () => {
    const v = checkSchedule({ networks: ['ig', 'ig'], date: '2026-11-13', time: '09:00', caption: 'a'.repeat(4000), firstComment: 'b'.repeat(2000) }, ctx).value;
    expect(v.networks).toEqual(['ig']); expect(v.caption).toHaveLength(3000); expect(v.firstComment).toHaveLength(1000);
  });
});

const actx = { connected: ['ig', 'tg'], kind: 'still', aiReady: true, designName: 'Daily gold' };
describe('checkAutomation', () => {
  it('accepts weekly with sorted unique days, and names it after the design by default', () => {
    expect(checkAutomation({ cadence: 'weekly', days: [4, 1, 4], time: '09:00', networks: ['ig'] }, actx).value)
      .toEqual({ name: 'Daily gold', cadence: { kind: 'weekly', days: [1, 4], time: '09:00' }, networks: ['ig'], caption: { mode: 'fixed', text: '' }, startDate: '', endDate: '' });
  });
  it('drops days for daily and weekdays', () => { expect(checkAutomation({ cadence: 'weekdays', days: [6], time: '08:00', networks: ['ig'] }, actx).value.cadence.days).toEqual([]); });
  it('needs days for weekly, a time, and a known cadence', () => {
    expect(checkAutomation({ cadence: 'weekly', days: [], time: '09:00', networks: ['ig'] }, actx).error).toMatch(/days/);
    expect(checkAutomation({ cadence: 'weekly', days: [9], time: '09:00', networks: ['ig'] }, actx).error).toMatch(/days/);
    expect(checkAutomation({ cadence: 'daily', networks: ['ig'] }, actx).error).toMatch(/time/);
    expect(checkAutomation({ cadence: 'hourly', time: '09:00', networks: ['ig'] }, actx).error).toMatch(/daily, weekdays, weekly/);
  });
  it('refuses videos', () => {
    ['reel', 'video'].forEach((kind) => expect(checkAutomation({ cadence: 'daily', time: '09:00', networks: ['ig'] }, { ...actx, kind }).error).toBe('Automations publish still designs only'));
  });
  it('turns an AI caption into a fixed one when AI is not ready, with a note', () => {
    const r = checkAutomation({ cadence: 'daily', time: '09:00', networks: ['ig'], captionMode: 'ai', caption: 'brief' }, { ...actx, aiReady: false });
    expect(r.value.caption).toEqual({ mode: 'fixed', text: 'brief' }); expect(r.note).toMatch(/AI/);
  });
  it('refuses an end before the start, and malformed dates', () => {
    expect(checkAutomation({ cadence: 'daily', time: '09:00', networks: ['ig'], startDate: '2026-12-01', endDate: '2026-11-01' }, actx).error).toMatch(/end/i);
    expect(checkAutomation({ cadence: 'daily', time: '09:00', networks: ['ig'], startDate: 'soon' }, actx).error).toMatch(/date/);
  });
  it('checks networks as checkSchedule does', () => { expect(checkAutomation({ cadence: 'daily', time: '09:00', networks: ['li'] }, actx).error).toMatch(/ig, tg/); });
});

describe('plannerView', () => {
  const posts = [
    { d: 'a', date: '2026-11-14', time: '09:00', pf: ['ig'], status: 'Scheduled' },
    { d: 'b', date: '2026-11-13', time: '08:00', pf: ['ig', 'x'], status: 'Scheduled', auto: 'au1' },
    { d: 'a', date: '2026-11-13', time: '10:00', pf: ['li'], status: 'Draft' },
    { d: 'gone', date: '2026-11-20', time: '10:00', pf: ['li'], status: 'Published' },
    { d: 'a', date: '2026-12-30', time: '10:00', pf: ['li'], status: 'Scheduled' },
    { d: 'a', date: '2026-11-01', time: '10:00', pf: ['li'], status: 'Published' },
  ];
  const src = { posts, designs: [{ id: 'a', name: 'Gold' }, { id: 'b', name: 'Calendar' }], automations: [{ name: 'Daily', d: 'b', active: true, cadence: { kind: 'weekdays', days: [], time: '08:00' }, pf: ['ig'] }], connected: ['ig', 'li'], tz: 'Europe/Istanbul', today: '2026-11-12', now: '15:40', days: 14, openDesign: { id: 'a', name: 'Gold', kind: 'still' }, bestTimes: { '2026-11-13': ['12:30'] }, nextFreeSlot: { date: '2026-11-13', time: '12:30' } };
  it('lists non-draft posts in the window, sorted, with design names and deleted designs named', () => {
    const v = plannerView(src);
    expect(v.posts.map((p) => `${p.date} ${p.time} ${p.design}`)).toEqual(['2026-11-13 08:00 Calendar', '2026-11-14 09:00 Gold', '2026-11-20 10:00 (deleted design)']);
    expect(v.posts[0]).toEqual({ date: '2026-11-13', time: '08:00', networks: ['ig', 'x'], design: 'Calendar', status: 'Scheduled', automation: true });
  });
  it('says when the open design is already scheduled', () => { expect(plannerView(src).openDesign.scheduled).toEqual(['2026-11-14 09:00']); });
  it('describes automations in words and passes the rest through', () => {
    const v = plannerView(src);
    expect(v.automations).toEqual([{ name: 'Daily', design: 'Calendar', active: true, cadence: 'Weekdays at 08:00', networks: ['ig'] }]);
    expect([v.timeZone, v.today, v.now]).toEqual(['Europe/Istanbul', '2026-11-12', '15:40']);
    expect(v.nextFreeSlot).toEqual({ date: '2026-11-13', time: '12:30' });
  });
  it('caps the list at 60 and the window at 31 days', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ d: 'a', date: '2026-11-13', time: `${String(8 + (i % 12)).padStart(2, '0')}:00`, pf: ['ig'], status: 'Scheduled' }));
    expect(plannerView({ ...src, posts: many }).posts).toHaveLength(60);
    expect(plannerView({ ...src, days: 99 }).posts.map((p) => p.date)).toContain('2026-11-20');
    expect(plannerView({ ...src, days: 99 }).posts.map((p) => p.date)).not.toContain('2026-12-30');
  });
  it('reports automations it could not read', () => {
    const v = plannerView({ ...src, automations: null, automationsError: 'offline' });
    expect(v.automations).toEqual([]); expect(v.automationsError).toBe('offline');
  });
});

describe('cadenceWords', () => {
  it('says each rhythm in words', () => {
    expect(cadenceWords({ kind: 'daily', days: [], time: '18:00' })).toBe('Every day at 18:00');
    expect(cadenceWords({ kind: 'weekdays', days: [], time: '08:00' })).toBe('Weekdays at 08:00');
    expect(cadenceWords({ kind: 'weekly', days: [1], time: '09:00' })).toBe('Every Monday at 09:00');
    expect(cadenceWords({ kind: 'weekly', days: [1, 4], time: '09:00' })).toBe('Every Monday and Thursday at 09:00');
    expect(cadenceWords({ kind: 'weekly', days: [1, 3, 5], time: '09:00' })).toBe('Every Monday, Wednesday and Friday at 09:00');
  });
});

describe('cardLines', () => {
  const o = { designName: 'Gold', dateLabel: (d) => (d === '2026-11-13' ? 'Fri, 13 Nov' : d), netName: (k) => ({ ig: 'Instagram', li: 'LinkedIn' }[k]) };
  it('describes a post', () => {
    expect(cardLines({ kind: 'post', networks: ['ig', 'li'], date: '2026-11-13', time: '09:00', caption: 'Hi' }, o)).toEqual({ title: 'Post', sub: 'Gold', lines: ['Fri, 13 Nov, 09:00', 'Instagram, LinkedIn', 'Hi'] });
  });
  it('describes an automation, with an AI caption and dates', () => {
    expect(cardLines({ kind: 'automation', name: 'Daily gold', cadence: { kind: 'weekdays', days: [], time: '08:00' }, networks: ['ig'], caption: { mode: 'ai', text: '' }, startDate: '2026-11-13', endDate: '' }, o))
      .toEqual({ title: 'Automation', sub: 'Daily gold', lines: ['Weekdays at 08:00', 'Instagram', 'AI caption', 'From Fri, 13 Nov'] });
  });
  it('leaves out an empty caption', () => { expect(cardLines({ kind: 'post', networks: ['ig'], date: '2026-11-13', time: '09:00', caption: '' }, o).lines).toHaveLength(2); });
});

describe('freeSlot', () => {
  const times = () => ['09:30', '12:30', '18:30'];
  it('takes the first best time at least 30 minutes ahead in the workspace zone', () => {
    expect(freeSlot({ now: { date: '2026-11-12', time: '12:10' }, timesFor: times, taken: () => false })).toEqual({ date: '2026-11-12', time: '18:30' });
    expect(freeSlot({ now: { date: '2026-11-12', time: '11:59' }, timesFor: times, taken: () => false })).toEqual({ date: '2026-11-12', time: '12:30' });
  });
  it('goes to the next day after the last time, and skips taken slots', () => {
    expect(freeSlot({ now: { date: '2026-11-12', time: '20:00' }, timesFor: times, taken: () => false })).toEqual({ date: '2026-11-13', time: '09:30' });
    expect(freeSlot({ now: { date: '2026-11-30', time: '20:00' }, timesFor: times, taken: (d, t) => d === '2026-12-01' && t === '09:30' })).toEqual({ date: '2026-12-01', time: '12:30' });
  });
  it('falls back to tomorrow at 09:00 when three weeks are full', () => {
    expect(freeSlot({ now: { date: '2026-12-31', time: '08:00' }, timesFor: times, taken: () => true })).toEqual({ date: '2027-01-01', time: '09:00' });
  });
});
describe('upcomingTimes', () => {
  it('drops the times of today that have passed', () => {
    expect(upcomingTimes({ date: '2026-11-12', time: '12:10' }, '2026-11-12', ['09:30', '12:30'])).toEqual(['12:30']);
    expect(upcomingTimes({ date: '2026-11-12', time: '12:10' }, '2026-11-13', ['09:30', '12:30'])).toEqual(['09:30', '12:30']);
  });
});
