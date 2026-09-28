# Backpocket setup

Everything here stays on free tiers: GitHub Pages + Actions, the Supabase free plan and the Gemini API free tier. Do the steps in order. Nothing in this list puts a secret into the website: the Supabase URL and anon/publishable key are public by design (access is enforced by row-level security), and the Gemini key only ever lives in Supabase Edge Function secrets.

Without steps 1–5 the app still works fully as a local, offline, no-account app ("guest mode"); sign-in, sync and AI just stay hidden.

You'll need: a GitHub account (this repo), a Google account, [Node.js 22](https://nodejs.org) (`nvm use` / `fnm use` reads `.nvmrc`), and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) (`npx supabase …` works without installing it).

---

## 1. Create the Supabase project

1. Go to <https://supabase.com/dashboard> → **New project**. Pick a name (e.g. `backpocket`), a region near you, and a strong database password (save it).
2. When it's ready, open **Project Settings → API Keys** (older projects: **Project Settings → API**) and copy:
   - **Project URL** - `https://<project-ref>.supabase.co`
   - the **publishable key** (`sb_publishable_…`) - or, on older projects, the legacy **anon** key. Either works.
   - Never copy the secret / service_role key anywhere outside Supabase.
3. In GitHub: **this repo → Settings → Secrets and variables → Actions → Variables → New repository variable**, and add:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | the publishable (or anon) key |

   (Repository *secrets* with the same names also work; the workflow reads either.)

## 2. Google sign-in

**Google Cloud** - <https://console.cloud.google.com>:

1. Create a project (or reuse one), then open **Google Auth Platform**.
2. **Branding**: app name "Backpocket", your support email. **Audience**: *External*. While the app is in *Testing*, add yourself (and anyone else) under **Test users**; publish it later if other people should sign in.
3. **Data Access**: add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
4. **Clients → Create client → Web application**:
   - **Authorized JavaScript origins**: `https://mohammeddev07.github.io` and `http://localhost:5173`
   - **Authorized redirect URIs**: `https://<project-ref>.supabase.co/auth/v1/callback` and `http://127.0.0.1:54321/auth/v1/callback`
   - Save, and copy the **Client ID** and **Client secret**.

**Supabase dashboard**:

5. **Authentication → Sign In / Providers → Google**: turn it on, paste the Client ID and Client secret, save.
6. **Authentication → URL Configuration**:
   - **Site URL**: `https://mohammeddev07.github.io/Backpocket/`
   - **Redirect URLs** (add each): `https://mohammeddev07.github.io/Backpocket/`, `http://localhost:5173/Backpocket/`, `http://localhost:4173/Backpocket/`

   Backpocket sends people back to exactly `…/Backpocket/`, so no wildcards are needed.

## 3. Database: tables, security rules, pgvector

From the repo folder:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>      # asks for the database password
npx supabase db push                                # runs supabase/migrations/*.sql
```

This creates the `folders`, `links`, `plans`, `ai_allowlist`, `rate_limit_buckets` and `ai_usage_daily` tables, turns on row-level security (each user sees only their own rows; the AI tables are service-role only), enables the **pgvector** extension (`create extension vector` is in the first migration), and adds the rate-limit and search functions.

Check: **Database → Extensions** shows `vector` enabled; **Table Editor** shows the tables with a "RLS enabled" badge.

(No CLI? Paste `supabase/migrations/20260928000001_core_schema.sql` and then `…000002_ai.sql` into **SQL Editor → New query** and run them in that order.)

## 4. Gemini key and Edge Functions

1. Get a free key at <https://aistudio.google.com/apikey> (**Create API key**). Check your project's free-tier limits at <https://aistudio.google.com/rate-limit> - Google shows them per project.
2. Store it as a Supabase secret (this is the only place it goes):

   ```bash
   npx supabase secrets set GEMINI_API_KEY=<your-key>
   # optional - defaults to the GitHub Pages site + localhost:
   # npx supabase secrets set ALLOWED_ORIGINS=https://mohammeddev07.github.io,http://localhost:5173
   ```

3. Deploy the functions:

   ```bash
   npx supabase functions deploy ai
   npx supabase functions deploy delete-account
   ```

   Both keep JWT verification on (`supabase/config.toml`), so only signed-in users can call them.

4. Tune the limits if needed: `supabase/functions/_shared/config.ts` → `AI_CONFIG.limits`. The global bucket (9 requests, refilling 9/minute) and daily cap (600) assume a free tier of roughly 15 requests/minute and 1,000/day and sit at ~60% of that; set them from what AI Studio shows for `gemini-3.5-flash-lite`, then redeploy the `ai` function and push the site.

## 5. Who can use your Gemini key

Only emails in `ai_allowlist` use your key. In **SQL Editor**:

```sql
insert into public.ai_allowlist (email) values ('you@gmail.com');
-- more people:
insert into public.ai_allowlist (email, note) values ('friend@gmail.com', 'Alex');
```

Emails must be lowercase (a check constraint enforces it). Everyone else who signs in is offered **"Use your own free Gemini key"**: their key stays in their browser and their calls go straight to Google, never through your function or quota.

To remove someone: `delete from public.ai_allowlist where email = 'friend@gmail.com';` (their app notices within 12 hours, or right away on the next 403).

## 6. GitHub Pages from GitHub Actions

**Do this before merging the v2 branch into `develop`.** The live site currently serves the repo files straight from the branch; once the Vite source lands there it would serve an unbuilt page.

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `develop` (or run **Actions → Deploy to GitHub Pages → Run workflow**). The workflow installs, runs the tests, builds with your `VITE_SUPABASE_*` variables, fails if a Google API key ever shows up in `dist/`, and publishes `dist/`.
3. Open <https://mohammeddev07.github.io/Backpocket/> - existing data migrates on first load (the old `localStorage` copy is kept as `backpocket_data_v1_backup`).

## 7. Local development

```bash
npm i
npm run dev            # http://localhost:5173/Backpocket/ - guest mode unless .env is set
npm test               # Vitest (share parsing, migrations, sync, AI rules)
npm run build          # type-check + production build into dist/
npm run preview        # serve dist/ at http://localhost:4173/Backpocket/ (service worker on)
npm run check:functions  # type-check the Edge Functions with Deno
```

To point local dev at your hosted project, copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

**Fully local Supabase stack** (needs Docker):

```bash
export SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=<client id>
export SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET=<client secret>
npx supabase start                  # prints the local API URL and keys
npx supabase db reset               # applies supabase/migrations to the local database
echo "GEMINI_API_KEY=<key>" > supabase/functions/.env
npx supabase functions serve --env-file supabase/functions/.env
```

Then set `.env` to `VITE_SUPABASE_URL=http://127.0.0.1:54321` and the printed publishable/anon key, add yourself to `ai_allowlist` in the local Studio (<http://127.0.0.1:54323>), and run `npm run dev`.

`.env`, `supabase/functions/.env`, `dist/` and `node_modules/` are git-ignored.

---

### iPhone Shortcut link (optional)

Once you've built the "Backpocket" Shortcut (Settings → *Add to iPhone share sheet* in the app shows the steps), share it from the Shortcuts app with **Copy iCloud Link** and paste the link into `IOS_SHORTCUT_URL` in `src/config.ts`. The help screen then offers it as a one-tap install.

### Troubleshooting

- **Sign-in returns to the app but you're not signed in**: the redirect URL isn't allowlisted (step 2.6), or the Google client's redirect URI doesn't match `https://<project-ref>.supabase.co/auth/v1/callback`.
- **iPhone home-screen app ends up in Safari after Google sign-in**: expected on some iOS versions; the app explains what to do. Signing in from Safari and using Backpocket there works too.
- **AI says "Slow down"**: that's the per-user token bucket (5 at once, then one every 6 seconds). "Daily AI limit reached" resets at midnight Pacific time.
- **AI never turns on for your account**: check the email in `ai_allowlist` is exactly your Google email, lowercase; in the app use Settings → AI → *Check access again*.
