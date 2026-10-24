-- AI contract v0.5: request tracking and deduplication

create table public.ai_requests (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,

  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),

  result jsonb,
  error_code text,

  created_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint ai_requests_completed_result_check
    check (status <> 'completed' or result is not null)
);

create index ai_requests_user_created_idx
  on public.ai_requests(user_id, created_at desc);