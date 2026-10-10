-- "More like this", near-duplicate checks and smarter reminder picks, all from
-- embeddings the app already stores (no AI calls). Both functions run as the
-- caller (RLS applies) and only ever touch the caller's own rows.

-- ---------------------------------------------------------------- related links
-- Nearest saves to one link, by its stored embedding.
create or replace function public.related_links(
  p_link uuid,
  match_count integer default 12
)
returns table (id uuid, similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  with src as (
    select l.embedding
    from public.links l
    where l.id = p_link
      and l.user_id = (select auth.uid())
      and l.embedding is not null
  )
  select l.id, 1 - (l.embedding operator(extensions.<=>) src.embedding) as similarity
  from public.links l, src
  where l.user_id = (select auth.uid())
    and l.id <> p_link
    and l.deleted_at is null
    and l.embedding is not null
  order by l.embedding operator(extensions.<=>) src.embedding
  limit least(greatest(coalesce(match_count, 12), 1), 50);
$$;

-- ---------------------------------------------------------------- reminder picks
-- Forgotten saves (never opened, not done, at least p_min_age_days old),
-- ranked by how close they are to what the person saved most recently
-- (the average embedding of their last p_recent saves).
create or replace function public.revisit_picks(
  p_min_age_days integer default 7,
  p_recent integer default 10,
  match_count integer default 10
)
returns table (id uuid, similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  with recent as (
    select l.embedding
    from public.links l
    where l.user_id = (select auth.uid())
      and l.deleted_at is null
      and l.embedding is not null
    order by l.created_at desc
    limit least(greatest(coalesce(p_recent, 10), 1), 50)
  ),
  centre as (
    -- pgvector's avg(vector) lives in the extensions schema (search_path is empty).
    select extensions.avg(embedding) as v from recent
  )
  select l.id, 1 - (l.embedding operator(extensions.<=>) centre.v) as similarity
  from public.links l, centre
  where centre.v is not null
    and l.user_id = (select auth.uid())
    and l.deleted_at is null
    and l.embedding is not null
    and l.opened_at is null
    and l.status <> 'done'
    and l.created_at <= now() - make_interval(days => greatest(coalesce(p_min_age_days, 7), 0))
  order by l.embedding operator(extensions.<=>) centre.v
  limit least(greatest(coalesce(match_count, 10), 1), 50);
$$;

revoke all on function public.related_links(uuid, integer) from public, anon;
revoke all on function public.revisit_picks(integer, integer, integer) from public, anon;
grant execute on function public.related_links(uuid, integer) to authenticated, service_role;
grant execute on function public.revisit_picks(integer, integer, integer) to authenticated, service_role;
