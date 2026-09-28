// AI configuration shared by the Edge Function (Deno) and the browser's
// bring-your-own-key client, so both behave the same. Pure data - no
// runtime-specific APIs in _shared/.

export const AI_CONFIG = {
  /** Gemini 3.5 Flash-Lite (stable) - https://ai.google.dev/gemini-api/docs/models */
  model: 'gemini-3.5-flash-lite',
  /** Lowest thinking level this model accepts (it can't be switched off). */
  thinkingLevel: 'MINIMAL',
  embeddingModel: 'gemini-embedding-2',
  /** Must match the vector(768) column in supabase/migrations. */
  embeddingDims: 768,

  /** Sort-on-save: move automatically at or above this confidence, otherwise suggest. */
  autoApplyConfidence: 0.8,
  /** Semantic search: drop matches below this cosine similarity. */
  minSimilarity: 0.3,
  searchResults: 30,

  timeoutsMs: { classify: 4000, search: 6000, plan: 30000, embed: 15000, status: 5000 },

  /** Token buckets. user: burst 5, then 1 per 6 s => never more than ~15 in any 60 s. */
  limits: {
    user: { capacity: 5, refillPerSec: 1 / 6 },
    // Keep all users together comfortably under the project's free-tier RPM.
    // Google shows the exact free-tier numbers per project in AI Studio
    // (https://aistudio.google.com/rate-limit); these assume ~15 RPM / 1,000
    // RPD and start at ~60% of that. Adjust after checking yours.
    global: { capacity: 9, refillPerSec: 9 / 60 },
    dailyPerUser: 150,
    dailyGlobal: 600,
  },
  costs: { classify: 1, search: 1, plan: 3, embed: 1 },

  // Request-size guards.
  maxBodyBytes: 200_000,
  maxFolders: 150,
  maxExamplesPerFolder: 3,
  maxPlanLinks: 100,
  embedBatchMax: 20,
  maxEmbedChars: 2000,
  maxQueryChars: 300,
} as const;

export type AiAction = 'status' | 'classify' | 'search' | 'plan' | 'embed';
export type CostedAction = keyof typeof AI_CONFIG.costs;
