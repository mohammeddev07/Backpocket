import { describe, expect, it } from 'vitest';
import { relativeTime } from './format';

const NOW = new Date('2026-09-28T12:00:00Z').getTime();
const ago = (ms: number) => NOW - ms;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe('relativeTime', () => {
  it.each([
    [ago(10_000), 'just now'],
    [ago(5 * MIN), '5m ago'],
    [ago(3 * HOUR), '3h ago'],
    [ago(3 * DAY), '3d ago'],
    [ago(15 * DAY), '2w ago'],
    [NOW + 5000, 'just now'],
  ])('%s -> %s', (ts, expected) => expect(relativeTime(ts, NOW)).toBe(expected));

  it('falls back to a date after ~5 weeks', () => {
    expect(relativeTime(ago(60 * DAY), NOW)).toMatch(/\d/);
    expect(relativeTime(ago(400 * DAY), NOW)).toMatch(/2025/);
  });
});
