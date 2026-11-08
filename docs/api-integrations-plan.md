# External API integrations: assessment and implementation prompts

Candidates came from [public-apis](https://github.com/public-apis/public-apis). Each one is judged against what Backpocket is: a local-first PWA, guests with no backend, a free-tier AI budget (~600 calls/day for everyone), no secrets in the bundle, and a privacy promise that **Settings → Use local icons only** stops every third-party lookup.

## Verdicts at a glance

| # | Idea | Verdict | Why |
|---|------|---------|-----|
| 1 | Better previews for Instagram, Facebook, X and plain links (Microlink) | **Build** | Biggest visible gain. Today only YouTube/TikTok get a thumbnail and title. Most saves are Instagram, Facebook, X or articles. It also gives the AI a description to work with. |
| 2 | Privacy-friendlier favicons | **Build (small)** | The real leak is that we send Google the **full link URL** (`domain_url=`), not just the domain. Fixing that is a one-line change. Changing the provider is optional. |
| 3 | YouTube transcripts for the AI | **Skip** | Paid keys, scraping YouTube in a grey area, small free quotas, too slow for the 4 s sort-on-save timeout, and transcripts blow past `maxEmbedChars` (2000). Idea 1 already gives the AI the video description, which gets most of the benefit for free. |
| 4 | Link safety check (Safe Browsing / URLhaus) | **Skip** | Both now need a key (URLhaus requires an `Auth-Key` since abuse.ch put auth on all its APIs), so it would be server-only and signed-in only. Backpocket never opens links by itself. The browser's own Safe Browsing checks them when you tap one. Most saves come from Instagram, TikTok, YouTube, Facebook or X, which are trusted domains. It would also send every saved URL to one more party. |
| 5 | Email the weekly recap | **Not now; do Web Push instead (optional)** | Email needs a custom sending domain with SPF/DKIM (we can't set DNS on `pages.dev`), a provider account, an unsubscribe flow, a server-side recap and privacy-policy changes. The problem it solves (no background reminders on iPhone) is solved more directly by **Web Push**, which iOS 16.4+ supports for home-screen web apps. Push needs no third party and no user data on the server. |

Suggested order: **2 → 1 → (optional) 5-alt**. Idea 2 is small. Idea 1 is medium and includes a migration. Web Push is large and needs secrets and a cron job set up by the owner.

---

## 1. Rich previews via Microlink

### Analysis

- **Gap today:** `src/data/oembed.ts` only handles YouTube/TikTok (both have CORS-enabled oEmbed). Instagram, Facebook, X and plain links fall back to a local tile and favicon. Plain links also have no title unless the user types one.
- **Microlink:** `GET https://api.microlink.io/?url=<url>` returns `data.title`, `data.description`, `data.image.url`, `data.logo.url`, `data.publisher`. CORS is enabled and it works without a key. **Free quota: 25 requests/day** (per caller IP, since there's no key), concurrency 2, and HTTP 429 when the quota is used up. Called from the browser, each user has their own quota, which covers normal saving. The current backfill (`oembedBackfillPerLoad: 30`) would use it up in one load, so Microlink needs its own small budget.
- **Partial results are normal:** Instagram/Facebook often return a login wall ("Instagram", "Log in or sign up to view") for logged-out fetches. We must detect those generic values and treat them as "nothing found".
- **Expiring thumbnails:** Instagram/Facebook image URLs (`*.cdninstagram.com`, `*.fbcdn.net`) are signed and expire after days or weeks. A stored `thumbnailUrl` will eventually 403. We need a refresh path. The current `img.crossOrigin = 'anonymous'` may also fail if those CDNs don't send CORS headers. Verify this, and if they don't, load those hosts without `crossOrigin`; they then just aren't cached offline.
- **AI win:** `description` goes into classify input and the embedding text, so sort-on-save, semantic search and More like this improve for every platform, including YouTube (Microlink returns the video description).
- **Privacy:** Microlink sees the full URL. This must stay under **Use local icons only** and be disclosed in README, `privacy.html` and the Settings description.
- **Unfurlr** (the alternative) runs on a free Render instance that sleeps when idle. Cold starts are slower than our 4 s timeout, so it's not suitable.

### Implementation prompt

> Implement rich link previews using Microlink for platforms that have no CORS oEmbed. Read `CLAUDE.md` first and follow its conventions (no new dependencies, pure logic gets a Vitest file, copy without em/en dashes, styling only in `app.css`).
>
> **Scope:** YouTube and TikTok keep using `src/data/oembed.ts` (first party, no quota). Instagram, Facebook, X and `Link` use Microlink. YouTube also gets a Microlink call **only** to fetch its description, and only if quota is left. Make that a config flag, `previewDescribeYouTube`, default `true`.
>
> 1. **New pure module `src/data/preview.ts`** (+ `preview.test.ts`):
>    - `microlinkEndpoint(url)` → `https://api.microlink.io/?url=<enc>&palette=false&audio=false&video=false&iframe=false&screenshot=false`.
>    - `parseMicrolink(json): PreviewInfo | null` returning `{ title, description, thumbnailUrl }`. Accept only `https:` image URLs. Clip the title to 300 chars and the description to 1000. Trim and collapse whitespace.
>    - `isGenericPreview(info, platform)` drops login-wall junk: titles equal to the platform/site name ("Instagram", "Facebook", "X", "Log in or sign up to view", "Facebook - log in or sign up"), descriptions starting with "See posts, photos and more on Facebook" / "Create an account or log in to Instagram", and logo images used as thumbnails (`data.image.url === data.logo.url`). Unit-test this with real-looking fixtures for each platform, with both good and login-wall responses.
>    - `fetchPreview(url, platform, { timeoutMs, fetchImpl })` follows the style of `fetchOembed`: `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, AbortController timeout, never throws. It returns `{ info, rateLimited }`. A 429, or a body with `status: 'fail'` and a rate-limit code, sets `rateLimited`.
> 2. **Quota guard** (pure, testable): keep `{ day: 'YYYY-MM-DD', used: number, blockedUntil: ms }` in IndexedDB `meta` under the key `previewQuota`, with the key constant living in `preview.ts`. Allow at most `APP_CONFIG.previewDailyBudget` (default 20, below Microlink's 25 to leave headroom for the save-box preview). On a 429, set `blockedUntil` to the next local midnight. New saves always go before backfill.
> 3. **Data model:** add `description: string | null` to `Link` (`src/data/types.ts`). Add a migration `supabase/migrations/<timestamp>_link_description.sql` that adds `description text check (char_length(description) <= 1000)` to `links`. Update the column list in the `cheap_pull` function (copy it from `20261017000001_cheap_pull.sql` and recreate it with the new column), the column string and mappers in `src/data/supabaseStore.ts`, backup import/export (`backup.ts`, old backups without the field must still import), and the IndexedDB normaliser so old rows read as `null`. Add or extend tests for mapping and backup.
> 4. **Enrichment (`src/actions.ts`):** generalise `enrichLink` so YouTube/TikTok take the oEmbed path as today and the other platforms use `fetchPreview` with the quota guard. Keep these existing rules: never overwrite a `user` title (add `titleSource: 'preview'` to the union and to any SQL check constraint on `title_source`, and check the migration for one), an empty-string thumbnail means "tried, nothing there", skip when `localIconsOnly` or offline, and retry later if the request failed because we went offline. Add a separate, small Microlink backfill, `previewBackfillPerLoad`, default 5, newest first, so it can't use up the daily budget.
> 5. **Expiring thumbnails:** in `linkVisual` (`src/ui/list.ts`), when a thumbnail on `cdninstagram.com`/`fbcdn.net` errors, still swap in the fallback tile. Also call a new `refreshPreview(id)`, which clears `thumbnailUrl` back to `null` at most once per link per 7 days (track `previewCheckedAt` in memory or in a meta map, not on the synced row) so the next enrichment fetches a fresh URL. Check in a real browser whether those CDNs return `Access-Control-Allow-Origin`. If they don't, don't set `crossOrigin` for those hosts, and confirm `src/sw.ts` doesn't try to cache opaque responses into the thumbnail cache.
> 6. **Save box preview (`src/ui/saveBox.ts`):** show the Microlink thumbnail and title for Instagram/Facebook/X/Link too, using the same quota guard. Cache the result in memory for that URL so the save itself doesn't call again.
> 7. **AI:** pass `description` into the classify input (`parseClassifyInput` in `supabase/functions/ai/index.ts`, `ClassifyInput` and `classifyPrompt` in `supabase/functions/_shared/`, and the BYOK caller) and into `embedDocumentText` / `embedTextFor`. Change these in `_shared/` so the Edge Function and BYOK paths stay identical. Respect `maxEmbedChars`. In `sortOnSave.ts`, the existing `Promise.race([enrichLink(id), sleep(1500)])` now also waits for Microlink, so keep that cap. Rename `oembedTitle` to something like `fetchedTitle` and cover both `oembed` and `preview` sources. Changing the embedding text changes `textHash`, so existing links re-embed gradually. Confirm the embed batching and rate limits keep that inside budget, and if they don't, only include the description for links created after this change.
> 8. **Card UI:** optionally show `description` as one clamped, muted line under the title on cards that have no user note. Use only tokens, and check AA contrast in both themes.
> 9. **Privacy copy:** update the Settings description for **Use local icons only** (`index.html`) to name the services in plain words, for example "Skip icon, thumbnail and title lookups, so the links you save are never sent to Google, YouTube, TikTok or Microlink." Update README (feature list, the "Third parties" line, the ad-blocker row) and `privacy.html` (third parties list).
> 10. **Checks:** `npm test`, `npm run typecheck`, `npm run check:functions`, `npm run build`. Manually test in `npm run dev` with an Instagram reel, a Facebook post, an X post, a news article, then with local icons only turned on (no requests to api.microlink.io in the Network tab), then offline.
> 11. Don't run `supabase db push` or deploy. In the PR description, list the commands for the owner: `npx supabase db push`, then `npx supabase functions deploy ai`. The function must be deployed **after** the migration, and the frontend after both.

---

## 2. Favicons: stop leaking full URLs, optionally switch provider

### Analysis

- `faviconFor` in `src/platform.ts` builds `https://www.google.com/s2/favicons?sz=64&domain_url=<full URL>`. That sends Google the **whole saved link** (path, query, tracking ids), not just the site. The privacy copy suggests only icons are looked up.
- Fix: send the hostname only. Google: `?sz=64&domain=<host>`. That's the main privacy win at zero risk.
- Provider choice:
  - **Icon Horse** (`https://icon.horse/icon/<host>`): no key, generates a letter icon when a site has none. The free "Hobby" tier is **1,000 icons/month** with no published terms, and it's run by a single developer. Because `<img>` loads are per visitor, the limit is per IP in practice, but nothing guarantees that. It's fine as an option, risky as the only source.
  - **DuckDuckGo** (`https://icons.duckduckgo.com/ip3/<host>.ico`): no key, from a privacy-focused company, stable for years, no published quota.
  - **Recommendation:** hostname-only always. Pick a primary provider (DuckDuckGo suggested), and on error fall back to the platform icon as today. Don't chain providers: each extra request leaks the domain to one more party.
- Icons are per domain, so the cache key can move from `linkId + url` to the hostname. That means fewer `<img>` objects and fewer requests.

### Implementation prompt

> Make favicon lookups send only the site's hostname, and make the provider a single config value. Follow `CLAUDE.md`.
>
> 1. In `src/platform.ts`, add a pure `faviconUrl(url, provider)` (+ `platform.test.ts` cases, or a new small test file): it parses the hostname with `new URL()` and returns `null` for non-http(s) URLs, IP addresses, `localhost`, and hostnames without a dot. Providers: `'duckduckgo'` → `https://icons.duckduckgo.com/ip3/<host>.ico`, `'google'` → `https://www.google.com/s2/favicons?sz=64&domain=<host>`, `'iconhorse'` → `https://icon.horse/icon/<host>`. Put the chosen provider in `src/config.ts` (`faviconProvider`, default `'duckduckgo'`).
> 2. Change `faviconFor` to use it, set `img.referrerPolicy = 'no-referrer'`, and key `faviconCache` by hostname instead of `linkId + url`. Check that re-renders still reuse loaded images (the comment about flicker explains why the cache exists). A `null` URL renders the platform icon directly. Keep the `onerror` fallback.
> 3. Check `src/sw.ts`: the runtime cache rule for favicons must match the new host (search for the Google favicon host and update it). Favicons should still work offline once seen.
> 4. Update the privacy copy so it's exact: README "Third parties the page talks to", `privacy.html`, and the **Use local icons only** description in `index.html`. Say the icon service gets the site's domain, not the link.
> 5. `npm test`, `npm run typecheck`, `npm run build`. In `npm run dev`, confirm in the Network tab that favicon requests contain only hostnames and that none are made with local icons only turned on.

---

## 3. YouTube transcripts: skipped

Not worth it. TranscriptYT, BulkTranscripts and TubeToTranscript all need paid or limited keys (so server-only), scrape YouTube against its terms, add another processor of user data, take several seconds (sort-on-save gives the model 4 s), and return text far longer than the 2000-char embedding limit. That would mean a summarisation call per video, which the ~600 calls/day budget can't absorb. The Microlink description from idea 1 covers most of the gain. If YouTube sorting is still weak afterwards, the next cheap step is the YouTube Data API `videos.list` (1 quota unit per call, 10k units/day free, key kept in the Edge Function) for the full description and tags. That's also server-only.

## 4. Link safety check: skipped

Low value for the cost. Links are opened in the user's browser, which already runs Safe Browsing on navigation. Most saves are from big social platforms. Both APIs need a key (Safe Browsing Lookup API: Google key, non-commercial terms; URLhaus: free `Auth-Key`), so guests and BYOK users would get nothing without a new Edge Function action. It also sends every saved URL to another service. If it's ever wanted, the privacy-preserving version is the Safe Browsing **Update API** (local hash-prefix lists), which is a big project. A cheap local alternative is to flag obvious red flags in pure code: punycode lookalike hosts (`xn--`), raw IP hosts, `http:` on login-looking paths. That needs no network and no API.

## 5. Email recap: deferred. Better option: Web Push (optional)

### Why not email now

- A sending domain with SPF, DKIM and DMARC is needed for deliverability. `backpocketapp.pages.dev` can't have custom DNS, so this needs a custom domain first.
- Providers: Mailtrap (free sending tier, domain verification required) or MailChannels (the free Cloudflare Workers deal ended in 2024, so it now needs an account). SMTPfast is new and unproven.
- It also needs: an explicit opt-in, a one-click unsubscribe (`List-Unsubscribe` + `List-Unsubscribe-Post`, which Gmail/Yahoo require for bulk mail), a server-side recap (today `recap.ts` runs in the browser from IndexedDB), a pg_cron schedule, and updates to `privacy.html`.
- It only reaches signed-in users anyway.

### Web Push solves the stated problem more directly

iOS 16.4+ supports standard Web Push (VAPID) for **home-screen** web apps, and Backpocket is already a PWA with a service worker that builds nudges and recaps from IndexedDB. The server can send a content-free "wake up" push once a day. The service worker computes the nudge/recap locally using the existing pure `nudge.ts` / `recap.ts`, so the server never sees titles. That covers Android and desktop too, and replaces the unreliable `periodicsync`.

Constraints to respect: Safari revokes permission if a push arrives and no notification is shown, so the server must only send when there's something to show. It can check the user's unopened, non-deleted `links` count. The SW must always show a notification and fall back to a generic "You have N saves waiting" line. Permission must be requested from a user tap. It needs a real iPhone to test (the simulator doesn't support web push).

### Implementation prompt (only if you want it)

> Add Web Push so reminders and the weekly recap reach installed apps in the background, including iPhone home-screen apps (iOS 16.4+). Follow `CLAUDE.md`. Don't deploy or set secrets yourself; list the owner's commands in the PR.
>
> 1. **Migration:** a `push_subscriptions` table (`id uuid pk`, `user_id uuid references auth.users on delete cascade default auth.uid()`, `endpoint text unique`, `p256dh text`, `auth text`, `tz text`, `hour smallint` 0-23, `created_at`, `last_sent_at`, `failures smallint default 0`), RLS so users can only insert, select or delete their own rows. Remember that `search_path` is empty in functions.
> 2. **Edge Function `push`:** `POST /subscribe` and `DELETE /subscribe` (JWT required) to save or remove a subscription. A cron-only `POST /send` (protected by a shared secret header) picks subscriptions whose local `hour` is now and `last_sent_at` is over 20 h ago, and sends only to users with at least 1 unopened live link. Use the service role here, scoped per user. The payload is just `{ "kind": "daily" }`. Sign VAPID with Web Crypto in Deno (ES256 JWT, aes128gcm payload encryption per RFC 8291), or a well-known Deno-compatible `web-push` port if typecheck passes. Delete subscriptions on 404/410, and increment `failures` on other errors. Put shared helpers in `supabase/functions/_shared/` if the browser also needs them (e.g. the VAPID public key constant).
> 3. **Schedule:** a migration that uses `pg_cron` + `pg_net` to call `/send` hourly. Document that the owner must set `PUSH_CRON_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` with `npx supabase secrets set`.
> 4. **Service worker (`src/sw.ts`):** a `push` handler that reads IndexedDB read-only (never creates the DB or writes user rows, as today), reuses the same logic as the `periodicsync` path to build the recap-or-nudge notification, and **always** calls `showNotification`. If nothing specific is due, fall back to "You have N saves waiting". Reuse the existing `notificationclick` handling.
> 5. **UI (`src/ui/reminders.ts` + Settings):** when signed in and reminders are on, add a "Get reminders when the app is closed" control. It calls `Notification.requestPermission()` from the tap, then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, and sends the subscription plus `Intl.DateTimeFormat().resolvedOptions().timeZone` and the reminder hour. On iPhone outside standalone mode, explain that this works once the app is added to the Home Screen (reuse `isIos()` / `isStandalone()`). Unsubscribe on sign-out, on account deletion (`delete-account` function should also delete rows, though the cascade covers it), and when reminders are turned off.
> 6. **Copy:** update README "Reminders and weekly recap" (remove "iPhone gets the in-app nudge only", and explain the Home Screen requirement) and `privacy.html` (we store a push address per device. Push messages carry no content, and the text is built on your device.)
> 7. **Tests:** pure helpers (hour/timezone selection, the "should send" decision, payload building) get Vitest files. Run `npm test`, `npm run typecheck`, `npm run check:functions`, `npm run build`. Manual test: Chrome desktop and Android, and a real iPhone with iOS 16.4+ from the Home Screen.

---

## Sources

- Microlink pricing (free: 25 requests/day): https://microlink.io/pricing · API key docs: https://microlink.io/docs/sdk/parameters/api-key
- URLhaus API (Auth-Key required): https://urlhaus.abuse.ch/api/
- Icon Horse (Hobby: 1,000 icons/month): https://icon.horse/
- Apple, web push for Home Screen web apps (iOS 16.4+): https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
