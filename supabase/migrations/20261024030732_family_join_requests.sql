-- 家族への参加申請を管理する
create table public.family_join_requests (
  id uuid primary key default gen_random_uuid(),

  family_id uuid not null
    references public.families(id) on delete cascade,

  invitation_id uuid not null
    references public.invitations(id),

  child_id uuid not null
    references public.users(id) on delete cascade,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),

  reviewed_by uuid
    references public.users(id),

  reviewed_at timestamptz,

  created_at timestamptz not null default now(),

  constraint family_join_review_check
    check (
      (status = 'pending'
        and reviewed_by is null
        and reviewed_at is null)
      or
      (status in ('approved', 'rejected')
        and reviewed_by is not null
        and reviewed_at is not null)
    )
);

-- 同じ子どもが同じ家族に複数の承認待ち申請を作れないようにする
create unique index family_join_one_pending_per_child
  on public.family_join_requests(family_id, child_id)
  where status = 'pending';

-- 子ども・親が申請状況を検索しやすくする
create index family_join_requests_child_idx
  on public.family_join_requests(child_id, created_at desc);

create index family_join_requests_family_idx
  on public.family_join_requests(family_id, status);

-- フロントから直接書き換えられないようにする
alter table public.family_join_requests
  enable row level security;
  