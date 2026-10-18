-- Cheaper sync polling.
--  * sync_state: one row per user, bumped whenever any of their rows change, so
--    an idle poll is a single primary-key read instead of three range queries.
--  * pull_changes(): one call that returns the first page of changes for all
--    three kinds. Runs as the caller (RLS applies) and never returns embeddings.
-- The app falls back to the old per-table queries if either is missing.

create table public.sync_state (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  changed_at  timestamptz not null default clock_timestamp()
);

alter table public.sync_state enable row level security;
create policy "own sync_state: select" on public.sync_state for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.sync_state from anon;
revoke insert, update, delete on public.sync_state from authenticated;

-- Security definer so clients cannot write the row themselves. Fires after a
-- write was accepted (bp_sync_row returns null for dropped stale updates).
create or replace function public.bp_touch_sync_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.sync_state (user_id, changed_at) values (new.user_id, clock_timestamp())
  on conflict (user_id) do update set changed_at = excluded.changed_at;
  return null;
end;
$$;
revoke all on function public.bp_touch_sync_state() from public, anon, authenticated;

create trigger folders_touch after insert or update on public.folders
  for each row execute function public.bp_touch_sync_state();
create trigger links_touch after insert or update on public.links
  for each row execute function public.bp_touch_sync_state();
create trigger plans_touch after insert or update on public.plans
  for each row execute function public.bp_touch_sync_state();

-- Existing accounts start with a row, so the first idle poll can be skipped too.
insert into public.sync_state (user_id)
select distinct user_id from (
  select user_id from public.folders union select user_id from public.links union select user_id from public.plans
) u
on conflict do nothing;

-- ---------------------------------------------------------------- pull_changes
-- Rows with synced_at >= the given cursor (null = everything), oldest first,
-- up to p_limit per kind. A kind that returns p_limit rows may have more.
create or replace function public.pull_changes(
  p_folders timestamptz default null,
  p_links   timestamptz default null,
  p_plans   timestamptz default null,
  p_limit   integer default 500
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'folders', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.synced_at, f.id) from (
        select id, parent_id, name, color, is_system, position, created_at, updated_at, deleted_at, synced_at
        from public.folders
        where user_id = (select auth.uid()) and (p_folders is null or synced_at >= p_folders)
        order by synced_at, id limit least(greatest(p_limit, 1), 500)
      ) f), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.synced_at, l.id) from (
        select id, folder_id, url, platform, title, title_source, note, shared_text, thumbnail_url, tags, status,
               favorite, opened_at, ai_meta, created_at, updated_at, deleted_at, synced_at
        from public.links
        where user_id = (select auth.uid()) and (p_links is null or synced_at >= p_links)
        order by synced_at, id limit least(greatest(p_limit, 1), 500)
      ) l), '[]'::jsonb),
    'plans', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.synced_at, p.id) from (
        select id, folder_id, title, summary, items, model, created_at, updated_at, deleted_at, synced_at
        from public.plans
        where user_id = (select auth.uid()) and (p_plans is null or synced_at >= p_plans)
        order by synced_at, id limit least(greatest(p_limit, 1), 500)
      ) p), '[]'::jsonb)
  );
$$;
grant execute on function public.pull_changes(timestamptz, timestamptz, timestamptz, integer) to authenticated;
