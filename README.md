# Backpocket

Local-only bookmark manager. Save links, sort into nested folders, come back later. Single HTML file, no build, no backend.

## Features

- Nested folders with color tags
- Save a link + optional note
- Auto-detects platform (Instagram, YouTube, Facebook, TikTok, X) for icon/label; falls back to a live favicon lookup
- Light/dark mode toggle (remembers your choice, defaults to OS preference)
- Mobile-friendly (slide-out folder drawer)
- Everything stored in the browser's `localStorage` — no account, no server, no sync across devices

## Run it

Open `index.html` directly in a browser. That's it.

```
# Windows/WSL
explorer.exe "$(wslpath -w ./index.html)"
```

## Install & share from other apps (Android)

Backpocket is a PWA hosted on GitHub Pages under `/Backpocket/`. Once installed, it shows up in the Android share sheet.

1. Open the GitHub Pages site in Chrome on Android.
2. Open the folder menu (☰) and tap **Install app**. Or use Chrome's menu (⋮) → **Add to Home screen** → **Install**. Don't pick **Create shortcut**: a shortcut never appears in the share sheet.
3. In Instagram, YouTube, TikTok, Facebook, X (or any app), tap **Share** → **Backpocket**.
4. Backpocket opens with the link filled in (and the shared title as the note, when the app sends one). Pick a folder, add tags if you like, and tap **Save**. Nothing is saved until you tap Save.

If the shared content has no `http(s)` link, Backpocket shows an error under the link field so you can paste the link yourself.

> **Already installed Backpocket before share support was added?** Uninstall it (long-press the icon → **Uninstall**, or Chrome → Settings → Apps), then reinstall it from the site. Android only registers share targets when the app is installed, so older installs won't appear in the share sheet until you do this. Your saved links aren't affected: they live in Chrome's storage for the site, not in the installed app. Don't clear the site's data while doing this.

### Browser support

| | Chrome | Brave |
|---|---|---|
| App (desktop and Android) | ✅ | ✅ |
| Install as an app | ✅ desktop and Android | ✅ desktop. On Android it's a home-screen shortcut only |
| Appears in the Android share sheet | ✅ | ❌ Brave on Android can't create WebAPKs ([brave-browser#7357](https://github.com/brave/brave-browser/issues/7357)), and Android only registers share targets for WebAPKs |
| Works with Shields / ad blockers on | n/a | ✅ Fonts fall back to system fonts and favicons fall back to platform icons if they're blocked |

To use the share sheet on Android, install Backpocket from **Chrome**, even if Brave is your everyday browser. Each browser keeps its own `localStorage`, so links saved in Brave won't appear in the Chrome-installed app. To move them across, use **Backup & import** (download a backup in one browser, import it in the other).

### Backpocket isn't in the share sheet?

1. **Check that it's really installed and not a shortcut.** Open `chrome://webapks` in Chrome on the phone. Backpocket should be listed, with **Manifest URL** ending in `/Backpocket/manifest.webmanifest`.
   - **Not listed:** you have a shortcut (Brave's home-screen icon, or Chrome's **Create shortcut**). Delete it and install from Chrome as above.
   - **Listed, but Manifest URL ends in `manifest.json`:** the install came from an older version of the page. Uninstall it, open the site in Chrome, reload once, then install again. The **Install app** button is gone while the old install exists, so uninstall first.
2. **Open Android's full share sheet.** Instagram, TikTok and X show their own share panel first. Tap **More**, **Share to…** or **Other** to reach Android's list, and scroll it: new apps usually aren't in the top row.
3. **Install from Chrome.** Brave on Android can't register share targets (see below).

### How it works

- `manifest.webmanifest` declares a GET `share_target` pointing at `./index.html`, with `title`, `text` and `url` params. All paths are relative, so it works under `/Backpocket/` without hardcoding the repo name.
- Apps are inconsistent about where they put the link. Chrome maps Android's shared text to `text`, so most social apps send the link there, sometimes inside a caption ("Check out … https://vm.tiktok.com/…"). Backpocket checks `url`, then `text`, then `title`, and takes the first valid `http`/`https` URL. It drops trailing punctuation but keeps balanced parentheses.
- Once the form is filled in, the share params are removed from the address bar with `history.replaceState`, so a reload or Back doesn't apply them again. Normal loads (with no share params) aren't affected.
- The service worker fetches the page and manifest from the network first and uses the cache only offline. Otherwise, the first visit after a deploy would load the previous release's page and manifest, and installing then gave an app with no share target. Visitors still on the original cache-first worker (v1) get one automatic reload once the new worker takes over, because their old page can't refresh itself. Page loads are cached by path, ignoring the query string, so a share launch still opens offline and doesn't add a cache entry per share.
- Icons: `icon-192.png` and `icon-512.png` (`purpose: any`), plus `icon-512-maskable.png`, which has the artwork inside the 80% safe zone on an opaque background so Android's adaptive-icon masks don't clip it.

## Stack

Vanilla HTML/CSS/JS. Google Fonts (Source Serif 4 + Inter) via `@import`. Favicons via Google's `s2/favicons` endpoint, with an emoji fallback if that fails. No frameworks, no dependencies, no build step.

## Data

Everything lives under one `localStorage` key (`backpocket_data_v1`): a flat list of folders (id, name, parentId, color) and a flat list of links (id, url, folderId, platform, note, savedAt). Clearing site data or switching browsers loses your saves — there's no export/import yet.

Theme preference is stored separately under `backpocket_theme`.
