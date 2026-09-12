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

## Stack

Vanilla HTML/CSS/JS. Google Fonts (Source Serif 4 + Inter) via `@import`. Favicons via Google's `s2/favicons` endpoint, with an emoji fallback if that fails. No frameworks, no dependencies, no build step.

## Data

Everything lives under one `localStorage` key (`backpocket_data_v1`): a flat list of folders (id, name, parentId, color) and a flat list of links (id, url, folderId, platform, note, savedAt). Clearing site data or switching browsers loses your saves — there's no export/import yet.

Theme preference is stored separately under `backpocket_theme`.
