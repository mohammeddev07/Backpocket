-- AI support: rate limiting (token buckets + daily caps), semantic search,
-- and embedding writes. Limits are passed in by the Edge Function from one
-- config object (supabase/functions/_shared/config.ts).

-- ---------------------------------------------------------------- sync trigger tweak
-- An update that keeps the same updated_at isn't a new user edit (e.g. only
-- the embedding changed), so synced_at stays put and other devices don't
-- re-download the row.
create or replace function public.bp_sync_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null;
    end if;
    new.user_id := old.user_id;
    if new.updated_at = old.updated_at then
      new.synced_at := old.synced_at;
      return new;
    end if;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end;
$$;

-- ---------------------------------------------------------------- token bucket
-- tokens = least(capacity, tokens + elapsed_seconds * refill_per_sec), under a
-- row lock, in one transaction: concurrent requests queue on the lock, so there
-- is no window where two callers both see the same tokens. Unlike a fixed
-- "N per minute" window, there's no burst at the minute boundary: with
-- capacity 5 and 1 token / 6 s, no 60-second span can ever pass more than 15.
create or replace function public.consume_tokens(
  p_key text,
  p_cost numeric,
  p_capacity numeric,
  p_refill_per_sec numeric,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_tokens double precision;
  v_updated timestamptz;
  v_available double precision;
begin
  insert into public.rate_limit_buckets (key, tokens, updated_at)
  values (p_key, p_capacity, v_now)
  on conflict (key) do nothing;

  select tokens, updated_at into v_tokens, v_updated
  from public.rate_limit_buckets
  where key = p_key
  for update;

  v_available := least(p_capacity, v_tokens + greatest(0, extract(epoch from (v_now - v_updated))) * p_refill_per_sec);

  if v_available >= p_cost then
    update public.rate_limit_buckets set tokens = v_available - p_cost, updated_at = v_now where key = p_key;
    return jsonb_build_object('allowed', true, 'remaining', v_available - p_cost);
  end if;

  update public.rate_limit_buckets set tokens = v_available, updated_at = v_now where key = p_key;
  return jsonb_build_object(
    'allowed', false,
    'retry_after_seconds', greatest(1, ceil((p_cost - v_available) / p_refill_per_sec))
  );
end;
$$;

-- ---------------------------------------------------------------- admission
-- All-or-nothing: per-user bucket, global bucket, then daily caps (days follow
-- Pacific time, like the Gemini free-tier daily quota). Anything denied later
-- refunds what was taken earlier - all inside one transaction, with every
-- touched row locked until commit.
create or replace function public.ai_admit(
  p_user uuid,
  p_cost numeric,
  p_user_capacity numeric,
  p_user_refill numeric,
  p_global_capacity numeric,
  p_global_refill numeric,
  p_daily_user integer,
  p_daily_global integer,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_day date := (v_now at time zone 'America/Los_Angeles')::date;
  v_until_midnight integer := ceil(extract(epoch from (
    ((v_day + 1)::timestamp at time zone 'America/Los_Angeles') - v_now)));
  v_user_key text := 'user:' || p_user::text;
  v_res jsonb;
  v_user_count integer;
  v_global_count integer;
begin
  v_res := public.consume_tokens(v_user_key, p_cost, p_user_capacity, p_user_refill, v_now);
  if not (v_res->>'allowed')::boolean then
    return v_res || jsonb_build_object('reason', 'user_rate');
  end if;

  v_res := public.consume_tokens('global', p_cost, p_global_capacity, p_global_refill, v_now);
  if not (v_res->>'allowed')::boolean then
    update public.rate_limit_buckets set tokens = tokens + p_cost where key = v_user_key;
    return v_res || jsonb_build_object('reason', 'global_rate');
  end if;

  insert into public.ai_usage_daily (user_id, day, count) values (p_user, v_day, 0), (null, v_day, 0)
  on conflict (user_id, day) do nothing;
  select count into v_user_count from public.ai_usage_daily where user_id = p_user and day = v_day for update;
  select count into v_global_count from public.ai_usage_daily where user_id is null and day = v_day for update;

  if v_user_count >= p_daily_user or v_global_count >= p_daily_global then
    update public.rate_limit_buckets set tokens = tokens + p_cost where key in (v_user_key, 'global');
    return jsonb_build_object(
      'allowed', false,
      'reason', case when v_user_count >= p_daily_user then 'user_daily' else 'global_daily' end,
      'retry_after_seconds', greatest(1, v_until_midnight)
    );
  end if;

  update public.ai_usage_daily set count = count + 1 where user_id = p_user and day = v_day;
  update public.ai_usage_daily set count = count + 1 where user_id is null and day = v_day;
  return jsonb_build_object('allowed', true);
end;
$$;

revoke all on function public.consume_tokens(text, numeric, numeric, numeric, timestamptz) from public, anon, authenticated;
revoke all on function public.ai_admit(uuid, numeric, numeric, numeric, numeric, numeric, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.consume_tokens(text, numeric, numeric, numeric, timestamptz) to service_role;
grant execute on function public.ai_admit(uuid, numeric, numeric, numeric, numeric, numeric, integer, integer, timestamptz) to service_role;

-- ---------------------------------------------------------------- semantic search
-- Runs as the caller (RLS applies) and only for the caller's own rows.
create or replace function public.match_links(
  query_embedding extensions.vector(768),
  match_user uuid,
  filters jsonb default '{}'::jsonb,
  match_count integer default 30
)
returns table (id uuid, similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.id, 1 - (l.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.links l
  where l.user_id = match_user
    and match_user = (select auth.uid())
    and l.deleted_at is null
    and l.embedding is not null
    and (filters->>'platform' is null or l.platform = filters->>'platform')
    and (filters->>'after' is null or l.created_at >= (filters->>'after')::timestamptz)
    and (filters->>'before' is null or l.created_at < (filters->>'before')::timestamptz)
  order by l.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(coalesce(match_count, 30), 1), 100);
$$;

-- items: [{ "id": uuid, "embedding": "[0.1,...]", "hash": text }]
create or replace function public.set_link_embeddings(items jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.links l
  set embedding = (x->>'embedding')::extensions.vector(768),
      embedding_hash = x->>'hash'
  from jsonb_array_elements(items) as x
  where l.id = (x->>'id')::uuid
    and l.user_id = (select auth.uid());
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.match_links(extensions.vector, uuid, jsonb, integer) from public, anon;
revoke all on function public.set_link_embeddings(jsonb) from public, anon;
grant execute on function public.match_links(extensions.vector, uuid, jsonb, integer) to authenticated, service_role;
grant execute on function public.set_link_embeddings(jsonb) to authenticated, service_role;
