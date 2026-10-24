-- AI contract v0.5: search metadata

alter table public.messages
  add column if not exists search_metadata jsonb;