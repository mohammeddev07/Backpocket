-- Favorites: a starred flag on links. Syncs like any other edit (last write wins).
alter table public.links add column favorite boolean not null default false;
