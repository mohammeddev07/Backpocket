import { describe, expect, it } from 'vitest';
import { parseQuery } from './queryParse';

// Wed 2026-09-16, local time.
const NOW = new Date(2026, 8, 16, 15, 30);
const day = (y: number, m: number, d: number) => new Date(y, m, d).toISOString();

describe('parseQuery', () => {
  it('extracts a platform and keeps the rest for semantic search', () => {
    expect(parseQuery('that chess opening tiktok', NOW)).toEqual({ text: 'that chess opening', filters: { platform: 'TikTok' } });
    expect(parseQuery('yt pasta recipe', NOW).filters.platform).toBe('YouTube');
    expect(parseQuery('insta workout', NOW).filters.platform).toBe('Instagram');
  });

  it('understands relative dates', () => {
    expect(parseQuery('recipes from yesterday', NOW).filters).toEqual({ after: day(2026, 8, 15), before: day(2026, 8, 16) });
    expect(parseQuery('workout last week', NOW).filters).toEqual({ after: day(2026, 8, 7), before: day(2026, 8, 14) });
    expect(parseQuery('this month', NOW).filters).toEqual({ after: day(2026, 8, 1) });
    expect(parseQuery('last month jazz', NOW)).toEqual({ text: 'jazz', filters: { after: day(2026, 7, 1), before: day(2026, 8, 1) } });
    expect(parseQuery('past 3 days', NOW).filters).toEqual({ after: day(2026, 8, 13) });
  });

  it('combines platform and date', () => {
    const p = parseQuery('that chess opening video on tiktok last week', NOW);
    expect(p.filters).toEqual({ platform: 'TikTok', after: day(2026, 8, 7), before: day(2026, 8, 14) });
    expect(p.text).toBe('that chess opening video');
  });

  it('leaves plain queries alone', () => {
    expect(parseQuery('sourdough starter', NOW)).toEqual({ text: 'sourdough starter', filters: {} });
  });
});
