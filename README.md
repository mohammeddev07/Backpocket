# Backpocket

Save reels, shorts and links from your social apps, sort them into folders, and come back to them later. It's an installable web app (PWA) on GitHub Pages: <https://mohammeddev07.github.io/Backpocket/>.

It works fully offline without an account. Signing in with Google adds sync across devices and, optionally, AI sorting, search and plans.

## Features

- **Folders** — nested folders with color tags. Links saved without a folder go to **Inbox**, a system folder that can't be deleted. **All saves** and **Revisit** are views, not folders.
- **Cards** — dense cards with the platform icon (Instagram, YouTube, Facebook, TikTok, X, or the site's favicon), the title, the folder path (`Job › Interview`), the relative date and tags. YouTube and TikTok links get a thumbnail and title from their oEmbed endpoints, including for guests.
- **Status** — each link is unread or done, and opening one records when you did. **Revisit** shows unopened links saved at least 7 days ago, with a shuffle button.
- **Tags** — free-form, with autocomplete from tags you've already used.
- **Duplicate detection** — URLs are normalized (tracking params like `utm_*`, `igsh` and `si` are stripped, and `youtu.be` is expanded), so re-saving a link shows "Already saved in X · Open / Save anyway".
- **Search and filters** — instant keyword search over title, note, caption, tags and folder path. Scope, sort, platform, tag and status filters live in one bottom sheet, and active filters appear as dismissible chips.
- **Bulk select**, a searchable folder picker, light and dark mode, 44px tap targets and safe-area insets.
- **Backup & import** — export a JSON backup or a bookmarks HTML file (the format every browser imports). Import either format, or a v1 backup, and choose to merge or replace.
- **Sharing** — the Android share sheet, an iPhone Shortcut, and a desktop bookmarklet. See below.
- **Sync** (signed in) — offline-first. Every change saves locally first and syncs when you're online.
- **AI** (signed in, optional) — sort on save, semantic search, and folder → plan checklists. See [AI](#ai).

## Share from other apps

### Android

Once installed from Chrome, Backpocket appears in the Android share sheet.

1. Open the site in Chrome on Android.
2. Open the folder menu (☰) and tap **Install app**. Or use Chrome's menu (⋮) → **Add to Home screen** → **Install**. Don't pick **Create shortcut**: a shortcut never appears in the share sheet.
3. In Instagram, YouTube, TikTok, Facebook, X (or any app), tap **Share** → **Backpocket**.
4. Backpocket opens with the link filled in, and the shared caption kept with it. Pick a folder, add tags if you like, and tap **Save**. Nothing is saved until you tap Save.

If the shared content has no `http(s)` link, Backpocket shows an error under the link field so you can paste the link yourself.

> **Already installed Backpocket before share support was added?** Uninstall it (long-press the icon → **Uninstall**, or Chrome → Settings → Apps), then reinstall it from the site. Android only registers share targets when the app is installed, so older installs won't appear in the share sheet until you do this. Your saves aren't affected: they live in Chrome's storage for the site, not in the installed app. Don't clear the site's data while doing this.

#### Browser support

| | Chrome | Brave |
|---|---|---|
| App (desktop and Android) | ✅ | ✅ |
| Install as an app | ✅ desktop and Android | ✅ desktop. On Android it's a home-screen shortcut only |
| Appears in the Android share sheet | ✅ | ❌ Brave on Android can't create WebAPKs ([brave-browser#7357](https://github.com/brave/brave-browser/issues/7357)), and Android only registers share targets for WebAPKs |
| Works with Shields / ad blockers on | n/a | ✅ Fonts fall back to system fonts and favicons fall back to platform icons if they're blocked |

To use the share sheet on Android, install Backpocket from **Chrome**, even if Brave is your everyday browser. Each browser keeps its own storage, so saves in Brave don't show up in the Chrome-installed app. Sign in to the same account in both and they sync, or use **Backup & import** to move them across without an account.

#### Backpocket isn't in the share sheet?

1. **Check that it's really installed and not a shortcut.** Open `chrome://webapks` in Chrome on the phone. Backpocket should be listed, with **Manifest URL** ending in `/Backpocket/manifest.webmanifest`.
   - **Not listed:** you have a shortcut (Brave's home-screen icon, or Chrome's **Create shortcut**). Delete it and install from Chrome as above.
   - **Listed, but Manifest URL ends in `manifest.json`:** the install came from an older version of the page. Uninstall it, open the site in Chrome, reload once, then install again. The **Install app** button is hidden while the old install exists, so uninstall first.
2. **Open Android's full share sheet.** Instagram, TikTok and X show their own share panel first. Tap **More**, **Share to…** or **Other** to reach Android's list, and scroll it: new apps usually aren't in the top row.
3. **Install from Chrome.** Brave on Android can't register share targets (see above).

### iPhone

iOS doesn't support web-app share targets, so Backpocket uses an Apple Shortcut instead (free, no App Store). In the app, open **Settings → Add to iPhone share sheet** for the steps. It's also suggested once when you first open Backpocket on an iPhone. The Shortcut takes the shared link and opens `https://mohammeddev07.github.io/Backpocket/?url=<link>`, which goes through the same path as an Android share.

The Shortcut opens **Safari**, not the home-screen app, and iOS keeps their storage separate. Sign in to the same account in both so saves made through the Shortcut sync to the home-screen app.

### Desktop

**Settings → Save to Backpocket** has a bookmarklet. Drag it to your bookmarks bar, then click it on any page to save that page.

## AI

AI is optional and needs a signed-in account. Guests get keyword search and everything else except AI.

- **Sort on save.** Saving never waits for AI: the link saves right away, then Gemini looks at the link, caption, note and your folder tree. If it's confident (≥ 0.8) and the folder exists, the link moves there with a toast ("Moved to Job › Interview · Undo · Change"). Otherwise the card shows a suggestion you can accept or reject. If you picked a folder yourself, AI never moves the link. It only fills in a title or tags when you left them empty, and never overwrites what you typed.
- **Semantic search.** Keyword results appear as you type. Press Enter or tap **Ask** to search by meaning ("that chess opening video"). Words like "tiktok" or "last week" become filters, and if semantic search fails you get the keyword results instead.
- **Plans.** In a folder with at least two links, **Make a plan** turns them into a 5–15 step checklist. Each step links back to the saves it came from. Ticks sync, and you can regenerate, copy, share or delete a plan.

### Who pays for it

| Account | How AI calls run |
|---|---|
| Guest | No AI. The app shows "Sign in to use AI". |
| Signed in and on the allowlist | Through the `ai` Supabase Edge Function, using the project's Gemini key. |
| Signed in, not on the allowlist | The app offers **Use your own free Gemini key** (from [Google AI Studio](https://aistudio.google.com/apikey)). The key stays in your browser, and calls go straight from the browser to Google, never through Backpocket's server or its quota. |

The model is Gemini 3.5 Flash-Lite with the lowest thinking level and structured JSON output. Embeddings use `gemini-embedding-2` at 768 dimensions. Both kinds of access share the same prompts and schemas (`supabase/functions/_shared/`), so they behave the same.

Rate limits are token buckets in Postgres, so a burst across a minute boundary can't get around them. Each user gets 5 requests at once, then one every 6 seconds, up to 150 a day. A global bucket and a global daily cap keep all users together under the free tier. Going over returns HTTP 429 with `Retry-After`, and the app shows "Slow down — try again in Xs". Bring-your-own-key users get the same limits in the browser, to protect their own quota. All the numbers are in `supabase/functions/_shared/config.ts`.

## Privacy

- **Guests:** everything stays in your browser. Nothing is sent to a Backpocket server, because guests never talk to one.
- **Signed in:** your folders, links and plans sync to a Supabase database (settings stay on the device). Row-level security means each account can only read its own rows.
- **AI:** "AI features send the link, its caption and your note to Google Gemini." This note is shown in Settings and the first time you use AI, and there's an AI on/off switch in Settings.
- **Your own Gemini key** is stored only on that device (`localStorage`) and is only ever sent to Google.
- **Third parties the page talks to:** Google Fonts, Google's favicon service, and YouTube/TikTok oEmbed for thumbnails and titles. **Settings → Use local icons only** turns off the favicon, thumbnail and title lookups, so the links you save are never sent to them.
- **Deleting your account** (Settings → Delete my account and cloud data) removes the account and all its cloud rows. You can choose to keep a local copy on the device.
- The website bundle never contains the Gemini key. The deploy workflow fails if a Google API key shows up in `dist/`.

## Data

**On the device**, everything lives in the IndexedDB database `backpocket`:

| Store | Holds |
|---|---|
| `folders` | id, parentId, name, color, isSystem (Inbox), position, timestamps |
| `links` | id, folderId, url, platform, title, note, sharedText (the shared caption), thumbnailUrl, tags, status, openedAt, aiMeta, timestamps |
| `plans` | id, folderId, title, summary, items (`{text, done, linkIds}`), timestamps |
| `meta` | settings, the local schema version, sync cursors |
| `outbox` | rows changed locally that haven't been pushed to Supabase yet |

Deletes are soft (`deletedAt`) so they can sync. A few small things stay in `localStorage`: `backpocket_theme` (read before first paint), `backpocket-auth` (the Supabase session), and `backpocket_gemini_key` plus its rate-limit counters if you bring your own key.

**Upgrading from v1:** on first load, v2 copies everything from the old `localStorage` key `backpocket_data_v1` into IndexedDB. Links at the root move into Inbox and every id becomes a UUID. The old key is left untouched, and a raw copy is also kept as `backpocket_data_v1_backup`.

**In the cloud** (signed in), the Supabase tables `folders`, `links` and `plans` mirror the local stores, plus an `embedding vector(768)` column on `links` for semantic search. Sync pulls rows changed since the last sync and pushes the outbox. If two devices edit the same row, the last write wins. Sync runs on load, when the app regains focus, when it comes back online, and shortly after each change. The drawer footer shows the status ("Synced · 2 min ago" / "Offline — changes will sync"). On first sign-in with local saves, the app offers to upload them, skipping duplicates and merging folders by path.

**Backup & import** (Settings) exports a JSON backup (`backpocket-backup-YYYY-MM-DD.json`) or a bookmarks HTML file, and imports either one, or a v1 backup. Clearing site data removes the local copy. If you're signed in, it comes back from your account on the next sync. If you're a guest, only a backup brings it back.

## Development

Vite + TypeScript, with no UI framework. Also `idb` for IndexedDB, `@supabase/supabase-js`, a hand-written service worker built with `vite-plugin-pwa` (`injectManifest`), and Vitest. The backend is Supabase (Postgres + pgvector, Auth, Edge Functions in Deno).

```bash
npm i
npm run dev              # http://localhost:5173/Backpocket/ (guest mode unless .env is set)
npm test                 # Vitest
npm run build            # type-check + production build into dist/
npm run preview          # serve dist/ with the service worker on
npm run check:functions  # type-check the Edge Functions with Deno
```

Pushing to `develop` runs `.github/workflows/deploy.yml`, which tests, builds and publishes `dist/` to GitHub Pages.

```
src/
  main.ts, actions.ts, config.ts, platform.ts, sw.ts
  data/     IndexedDB store, v1 migration, sync, backup, URL normalization
  cloud/    Supabase client and auth
  ai/       Edge Function client, bring-your-own-key client, sort on save, search
  search/   keyword filters and query parsing
  share/    share-target URL extraction (+ tests against the v1 code)
  ui/       drawer, list, sheets, modals, settings
public/     manifest.webmanifest, icons/
supabase/
  migrations/           schema, RLS, pgvector, rate limits, match_links
  functions/ai/         classify / search / plan / embed
  functions/delete-account/
  functions/_shared/    config, prompts and schemas shared with the browser
```

### How the share target works

- `public/manifest.webmanifest` declares a GET `share_target` pointing at `./index.html`, with `title`, `text` and `url` params. All paths are relative, so it works under `/Backpocket/` without hardcoding the repo name.
- Apps are inconsistent about where they put the link. Chrome maps Android's shared text to `text`, so most social apps send the link there, sometimes inside a caption ("Check out … https://vm.tiktok.com/…"). `src/share/extractSharedUrl.ts` checks `url`, then `text`, then `title`, and takes the first valid `http`/`https` URL. It drops trailing punctuation but keeps balanced parentheses. The iPhone Shortcut and the bookmarklet use the same `?url=` path.
- Once the form is filled in, the share params are removed from the address bar with `history.replaceState`, so a reload or Back doesn't apply them again.
- The service worker (`src/sw.ts`, built to `sw.js`, the same URL as v1) fetches the page and manifest from the network first and uses the cache only offline. Otherwise, the first visit after a deploy would load the previous release's page and manifest, and installing then would give an app with no share target. Visitors still on the original cache-first worker get one automatic reload once the new worker takes over. Page loads are cached by path, ignoring the query string, so a share launch still opens offline and doesn't add a cache entry per share. Fonts and YouTube/TikTok thumbnails are cached at runtime. Supabase, Gemini and oEmbed calls are never served from the cache.
- Icons are in `public/icons/`: `icon-192.png` and `icon-512.png` (`purpose: any`), plus `icon-512-maskable.png`, which keeps the artwork inside the 80% safe zone on an opaque background so Android's adaptive-icon masks don't clip it.
