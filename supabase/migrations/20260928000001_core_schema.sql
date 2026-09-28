-- Backpocket core schema: folders, links, plans + AI access/limit tables.
--
-- Sync model (see src/data/sync.ts):
--  * ids are generated on the client (UUIDs), so rows can be created offline.
--  * updated_at is the client's edit time and decides conflicts: last write
--    wins, per row. The trigger below drops an incoming update whose
--    updated_at is older than the stored one.
--  * synced_at is set by the server on every accepted write; clients pull
--    "everything with synced_at after my cursor" (with a small overlap).
--  * deletes are soft (deleted_at), so they sync like any other edit.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------- folders
create table public.folders (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  parent_id   uuid,
  name        text not null check (char_length(name) between 1 and 200),
  color       text not null default '#f2b8c6' check (char_length(color) <= 40),
  is_system   boolean not null default false,
  position    double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  synced_at   timestamptz not null default clock_timestamp()
);

-- One live Inbox per user. The Inbox's id is the user's own id, so every
-- device agrees on it without coordination.
create unique index folders_one_inbox on public.folders (user_id) where is_system and deleted_at is null;
create index folders_user_updated on public.folders (user_id, updated_at);
create index folders_user_synced on public.folders (user_id, synced_at);

-- ---------------------------------------------------------------- links
create table public.links (
  id              uuid primary key,
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  folder_id       uuid not null,
  url             text not null check (char_length(url) <= 4000),
  normalized_url  text not null check (char_length(normalized_url) <= 4000),
  platform        text not null default 'Link',
  title           text check (char_length(title) <= 1000),
  title_source    text check (title_source in ('user', 'oembed', 'ai')),
  note            text check (char_length(note) <= 5000),
  shared_text     text check (char_length(shared_text) <= 5000),
  thumbnail_url   text check (char_length(thumbnail_url) <= 4000),
  tags            text[] not null default '{}',
  status          text not null default 'unread' check (status in ('unread', 'done')),
  opened_at       timestamptz,
  ai_meta         jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  synced_at       timestamptz not null default clock_timestamp(),
  -- Semantic search (Phase 4). 768 = Gemini embedding output_dimensionality.
  embedding       extensions.vector(768),
  -- Hash of the text that was embedded, so stale embeddings can be spotted.
  embedding_hash  text
);

create index links_user_updated on public.links (user_id, updated_at);
create index links_user_synced on public.links (user_id, synced_at);
create index links_user_normalized_url on public.links (user_id, normalized_url);
create index links_user_folder on public.links (user_id, folder_id);
create index links_embedding_hnsw on public.links using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------- plans
create table public.plans (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  folder_id   uuid not null,
  title       text not null check (char_length(title) <= 300),
  summary     text not null default '' check (char_length(summary) <= 4000),
  -- [{ id, text, done, link_ids: [] }]
  items       jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  model       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  synced_at   timestamptz not null default clock_timestamp()
);

create index plans_user_updated on public.plans (user_id, updated_at);
create index plans_user_synced on public.plans (user_id, synced_at);
create index plans_user_folder on public.plans (user_id, folder_id);

-- ---------------------------------------------------------------- sync trigger
create or replace function public.bp_sync_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- Last write wins: an older edit (e.g. a device that was offline) loses.
    if new.updated_at < old.updated_at then
      return null;
    end if;
    -- A row never changes owner.
    new.user_id := old.user_id;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end;
$$;

create trigger folders_sync before insert or update on public.folders
  for each row execute function public.bp_sync_row();
create trigger links_sync before insert or update on public.links
  for each row execute function public.bp_sync_row();
create trigger plans_sync before insert or update on public.plans
  for each row execute function public.bp_sync_row();

-- ---------------------------------------------------------------- RLS: user tables
alter table public.folders enable row level security;
alter table public.links enable row level security;
alter table public.plans enable row level security;

create policy "own folders: select" on public.folders for select to authenticated using (user_id = (select auth.uid()));
create policy "own folders: insert" on public.folders for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own folders: update" on public.folders for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own folders: delete" on public.folders for delete to authenticated using (user_id = (select auth.uid()));

create policy "own links: select" on public.links for select to authenticated using (user_id = (select auth.uid()));
create policy "own links: insert" on public.links for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own links: update" on public.links for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own links: delete" on public.links for delete to authenticated using (user_id = (select auth.uid()));

create policy "own plans: select" on public.plans for select to authenticated using (user_id = (select auth.uid()));
create policy "own plans: insert" on public.plans for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own plans: update" on public.plans for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own plans: delete" on public.plans for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.folders, public.links, public.plans from anon;

-- ---------------------------------------------------------------- AI access + limits (service role only)
-- Only these accounts use the project's Gemini key. Everyone else can bring
-- their own key, which never touches the server.
create table public.ai_allowlist (
  email       text primary key check (email = lower(email)),
  note        text,
  created_at  timestamptz not null default now()
);

-- Token buckets: key is 'user:<uuid>' or 'global'. See consume_tokens().
create table public.rate_limit_buckets (
  key         text primary key,
  tokens      double precision not null,
  updated_at  timestamptz not null default now()
);

-- Daily call counters: one row per user per day, plus user_id null = global.
create table public.ai_usage_daily (
  user_id  uuid references auth.users (id) on delete cascade,
  day      date not null,
  count    integer not null default 0,
  constraint ai_usage_daily_user_day unique nulls not distinct (user_id, day)
);

alter table public.ai_allowlist enable row level security;
alter table public.rate_limit_buckets enable row level security;
alter table public.ai_usage_daily enable row level security;
-- No policies: with RLS on and no policy, only the service role can read or write.
revoke all on public.ai_allowlist, public.rate_limit_buckets, public.ai_usage_daily from anon, authenticated;
