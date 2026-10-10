# CLAUDE.md

Backpocket is a local-first bookmark PWA (Vite + TypeScript, no UI framework) on GitHub Pages, with optional Supabase sync and Gemini AI. README.md covers features and data; this file is how to work in the code.

## Commands

```bash
npm run dev              # http://localhost:5173/Backpocket/ (guest mode unless .env has Supabase vars)
npm test                 # Vitest (jsdom); keep it green
npm run typecheck        # tsc for the app AND the service worker (tsconfig.sw.json)
npm run build            # typecheck + production build (dist/)
npm run check:functions  # Deno type-check of supabase/functions/*
```

Deploy: pushing to `develop` publishes the frontend (`.github/workflows/deploy.yml`). Backend is manual and done by the owner: `npx supabase db push` (migrations) and `npx supabase functions deploy ai`. Never run deploys, `db push` or anything against the live Supabase project yourself; write the migration/function and hand over the commands.

## Architecture in one screen

- `index.html` holds all static markup: the SVG icon sprite (`#i-*`, `#brand-mark`), dialogs, the inline theme + splash scripts/styles. UI modules grab elements by id with `byId()` (`src/ui/dom.ts`).
- `src/data/`: IndexedDB store (`store.ts` is the in-memory source of truth, persisted via `localStore.ts`), sync with Supabase (`sync.ts`, outbox pattern), v1 migration, backup. Pure modules shared with the service worker: `nudge.ts`, `recap.ts`, `tree.ts`.
- `src/ui/`: one module per surface (list, sidebar, settings, reminders, recap, sheets). `view.ts` holds UI state; `renderAll/renderMain/renderTree` re-render. Extension points instead of cross-imports: `addCardDecorator`, `addHeaderExtra`, `addLinkMenuItems`, `addRenderHook`, `addFolderMenuItems`.
- `src/ai/`: `aiCall()` routes to the Edge Function (allowlisted accounts) or straight to Gemini with the user's own key (`byok.ts`). `aiReady()` = access + the user's AI toggle; `aiSettled()` waits for the first access check (everyone starts as `guest`).
- `supabase/functions/_shared/`: config, prompts, JSON schemas and validators used by BOTH the Edge Function and the browser BYOK path. Change behaviour there, not in one caller.
- `src/sw.ts`: offline app shell, runtime caches, background reminders (`periodicsync`) and notification taps. It reads IndexedDB directly and must never create the DB or write user rows.

## Conventions

- Match the surrounding code: small functions, comments only for the non-obvious "why", no new dependencies for things a few lines can do.
- Styling lives in `src/styles/app.css` only. Components read tokens (`--paper`, `--paper-raised`, `--ink`, `--line`, `--accent`, `--accent-grad`, radii `--radius-sm/md/lg`). Light and dark differ only in token values (`:root` vs `:root[data-theme="dark"]`); never hard-code a colour in a component. Cards 16px radius, controls 12px.
- Icons come from the sprite (`svgIcon('name')`), never emoji. New icons go into the `<svg>` sprite in `index.html`.
- User-facing copy: plain, friendly, no em or en dashes (validators also strip them from AI text). Don't claim things the app doesn't do (e.g. "we never store your data" is only true for guests; the Settings notice switches wording on sign-in).
- Accessibility is required: 44px touch targets on coarse pointers, visible `:focus-visible`, AA contrast in both themes, everything honours `prefers-reduced-motion`.
- Pure logic gets a small Vitest file next to it (`*.test.ts`). Prefer testing pure helpers over DOM.

## Gotchas

- Base path is `/Backpocket/`. Manifest and share target use relative paths; keep them relative.
- Reminders and the recap store state in IndexedDB `meta` (`nudgeAt`, `nudgeNext`, `nudgeHistory`, `recap`, `recapNotifiedAt`), shared between page and worker. Keep keys in `nudge.ts` / `recap.ts`.
- Embedding features (More like this, duplicate warnings, smart reminder picks) only work signed in with AI on; they call SQL functions (`related_links`, `revisit_picks`) and must degrade silently when those fail.
- AI budget is tight (free tier, ~600 calls/day across all users). New AI features should reuse embeddings or cost about one call per user per day; set costs in `_shared/config.ts`.
- Migrations: `search_path` is empty in functions, so qualify pgvector bits (`operator(extensions.<=>)`, `extensions.avg`). Functions are `security invoker` and filter on `auth.uid()`.
- The service-worker cache name hashes the build file list, so deploys refresh the offline cache automatically; no manual version bump.
- Don't commit `.env`, `SETUP.md` or `plan.md` (git-ignored). The Gemini key never goes in the bundle; CI fails if one appears in `dist/`.
