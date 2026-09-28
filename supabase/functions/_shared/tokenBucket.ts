// Token bucket, the same maths as public.consume_tokens() in SQL. The server
// uses the SQL version (atomic, row-locked); the browser uses this one to pace
// bring-your-own-key calls so they don't burn through the user's own quota.

export interface Bucket { tokens: number; updatedAt: number }
export interface BucketRule { capacity: number; refillPerSec: number }
export type TakeResult = { allowed: true; bucket: Bucket } | { allowed: false; bucket: Bucket; retryAfterSeconds: number };

export function take(bucket: Bucket | null, cost: number, rule: BucketRule, now: number): TakeResult {
  const prev = bucket ?? { tokens: rule.capacity, updatedAt: now };
  const elapsed = Math.max(0, (now - prev.updatedAt) / 1000);
  const available = Math.min(rule.capacity, prev.tokens + elapsed * rule.refillPerSec);
  if (available >= cost) return { allowed: true, bucket: { tokens: available - cost, updatedAt: now } };
  return {
    allowed: false,
    bucket: { tokens: available, updatedAt: now },
    retryAfterSeconds: Math.max(1, Math.ceil((cost - available) / rule.refillPerSec)),
  };
}
