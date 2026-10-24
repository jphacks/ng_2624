-- AI contract v0.5: product metadata

alter table public.products
  add column if not exists size text
    check (size in ('small', 'medium', 'large'));

alter table public.products
  add column if not exists recommendation_reason text;

alter table public.products
  add column if not exists source_urls text[] not null default '{}';