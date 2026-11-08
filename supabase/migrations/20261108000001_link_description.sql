-- Link previews: the page's own description, from oEmbed/Microlink lookups.
-- It feeds sort-on-save and the embedding text. Syncs like any other field.
-- Apply this BEFORE releasing the frontend that sends it: until then, pushes
-- that include the column fail and sync retries.
alter table public.links
  add column description text check (char_length(description) <= 1000);

-- pull_changes() lists its columns, so it is recreated with the new one.
-- Same signature, so the existing grant still applies; restated for clarity.
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
        select id, folder_id, url, platform, title, title_source, note, shared_text, thumbnail_url, description, tags, status,
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
