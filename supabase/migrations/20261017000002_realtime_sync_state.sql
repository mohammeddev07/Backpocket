-- Push instead of poll: devices subscribe to their own sync_state row over
-- Realtime and pull as soon as it changes. Realtime applies the table's RLS
-- policy (own row only), so a device only hears about its own account.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_state'
     ) then
    alter publication supabase_realtime add table public.sync_state;
  end if;
end;
$$;
