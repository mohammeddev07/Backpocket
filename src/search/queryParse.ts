import type { SearchFilters } from '@shared/schemas.ts';

// Pulls simple filters out of a natural-language query without an LLM:
// platform names ("tiktok", "yt") and relative dates ("last week",
// "yesterday"). What's left is embedded for semantic search.

const PLATFORM_WORDS: Array<[RegExp, string]> = [
  [/\b(tik ?tok|tiktoks)\b/i, 'TikTok'],
  [/\b(instagram|insta|ig|reels?)\b/i, 'Instagram'],
  [/\b(youtube|yt|shorts)\b/i, 'YouTube'],
  [/\b(facebook|fb)\b/i, 'Facebook'],
  [/\b(twitter|tweets?)\b/i, 'X'],
];

function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
/** Monday-based week start. */
function startOfWeek(d: Date): Date { const s = startOfDay(d); return addDays(s, -((s.getDay() + 6) % 7)); }

export interface ParsedQuery { text: string; filters: SearchFilters }

export function parseQuery(input: string, now = new Date()): ParsedQuery {
  let text = ' ' + input.trim() + ' ';
  const filters: SearchFilters = {};

  for (const [re, platform] of PLATFORM_WORDS) {
    if (re.test(text)) { filters.platform = platform; text = text.replace(re, ' '); break; }
  }

  const today = startOfDay(now);
  const range = (after: Date, before?: Date) => {
    filters.after = after.toISOString();
    if (before) filters.before = before.toISOString();
  };
  const rules: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [/\b(from |since )?today\b/i, () => range(today)],
    [/\b(from )?yesterday\b/i, () => range(addDays(today, -1), today)],
    [/\b(from |during )?this week\b/i, () => range(startOfWeek(now))],
    [/\b(from |during )?last week\b/i, () => range(addDays(startOfWeek(now), -7), startOfWeek(now))],
    [/\b(from |during )?this month\b/i, () => range(new Date(now.getFullYear(), now.getMonth(), 1))],
    [/\b(from |during )?last month\b/i, () => range(new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1))],
    [/\b(from |during )?this year\b/i, () => range(new Date(now.getFullYear(), 0, 1))],
    [/\b(from |during )?last year\b/i, () => range(new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear(), 0, 1))],
    [/\b(in the )?(past|last) (\d{1,3}) days\b/i, (m) => range(addDays(today, -Number(m[3])))],
    [/\b(\d{1,3}) days ago\b/i, (m) => range(addDays(today, -Number(m[1])), addDays(today, -Number(m[1]) + 1))],
  ];
  for (const [re, apply] of rules) {
    const m = text.match(re);
    if (m) { apply(m); text = text.replace(re, ' '); break; }
  }

  // Drop filler left behind ("that … from", "the … on").
  text = text.replace(/\b(saved|from|on|in|during)\s*$/i, ' ').replace(/\s+/g, ' ').trim();
  return { text, filters };
}
