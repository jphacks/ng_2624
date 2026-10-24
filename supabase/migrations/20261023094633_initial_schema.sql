-- WishBridge baseline schema v0.1 (Supabase PostgreSQL)
-- Run in Supabase SQL Editor on a NEW project.
-- Authentication is managed by Supabase Auth; never store passwords here.
create extension if not exists pgcrypto;

create table public.users (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null,
 role text not null check(role in ('parent','child')),
 age_group text,
 grade_level integer check (grade_level between 1 and 12),
 onboarding_completed boolean not null default false,
 created_at timestamptz not null default now()
);
create table public.families (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 created_by uuid not null references public.users(id),
 created_at timestamptz not null default now()
);
create table public.family_members (
 family_id uuid not null references public.families(id) on delete cascade,
 user_id uuid not null references public.users(id) on delete cascade,
 family_role text not null check(family_role in ('parent','child')),
 joined_at timestamptz not null default now(),
 primary key(family_id,user_id)
);
create table public.invitations (
 id uuid primary key default gen_random_uuid(),
 family_id uuid not null references public.families(id) on delete cascade,
 created_by uuid not null references public.users(id),
 code_hash text not null unique,
 expires_at timestamptz not null,
 redeemed_by uuid references public.users(id),
 redeemed_at timestamptz,
 created_at timestamptz not null default now()
);
create table public.conversations (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.users(id) on delete cascade,
 kind text not null default 'private_ai' check(kind in ('private_ai')),
 created_at timestamptz not null default now(),
 unique(id,user_id)
);
create table public.messages (
 id uuid primary key default gen_random_uuid(),
 conversation_id uuid not null references public.conversations(id) on delete cascade,
 sender text not null check(sender in ('user','assistant','system')),
 content text not null,
 response_type text check(response_type in ('HEARING','PRODUCT','PERSUASION','PROPOSAL','NEGOTIATION')),
 created_at timestamptz not null default now()
);
create index messages_conversation_time_idx on public.messages(conversation_id,created_at);
create table public.user_preferences (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null unique references public.users(id) on delete cascade,
 interests text[] not null default '{}',
 desired_items text[] not null default '{}',
 expected_activities text[] not null default '{}',
 conditions text[] not null default '{}',
 budget_small integer check(budget_small>=0),
 budget_medium integer check(budget_medium>=0),
 budget_large integer check(budget_large>=0),
 preferred_task_difficulty integer check(preferred_task_difficulty between 1 and 5),
 updated_at timestamptz not null default now()
);
create table public.shared_conditions (
 id uuid primary key default gen_random_uuid(),
 family_id uuid not null references public.families(id) on delete cascade,
 source_user_id uuid not null references public.users(id),
 target_user_id uuid not null references public.users(id),
 content text not null,
 approved_at timestamptz not null,
 revoked_at timestamptz,
 created_at timestamptz not null default now(),
 check(source_user_id<>target_user_id)
);
create table public.negotiations (
 id uuid primary key default gen_random_uuid(),
 family_id uuid not null references public.families(id),
 child_id uuid not null references public.users(id),
 status text not null default 'gathering' check(status in ('gathering','proposing','awaiting_approval','revision_requested','agreed','closed')),
 created_at timestamptz not null default now(),
 closed_at timestamptz
);
create table public.products (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 price_jpy integer check(price_jpy>=0),
 product_url text not null check(product_url ~ '^https?://'),
 image_url text,
 description text,
 source text,
 price_checked_at timestamptz,
 created_at timestamptz not null default now()
);
create table public.proposals (
 id uuid primary key default gen_random_uuid(),
 negotiation_id uuid not null references public.negotiations(id) on delete cascade,
 product_id uuid not null references public.products(id),
 version integer not null check(version>=1),
 proposed_by uuid not null references public.users(id),
 persuasion_text text not null,
 purchase_conditions text[] not null default '{}',
 status text not null default 'draft' check(status in ('draft','pending','rejected','agreed','superseded')),
 created_at timestamptz not null default now(),
 unique(negotiation_id,version)
);
create table public.proposal_approvals (
 proposal_id uuid not null references public.proposals(id) on delete cascade,
 user_id uuid not null references public.users(id),
 decision text not null check(decision in ('approved','rejected','revision_requested')),
 comment text,
 decided_at timestamptz not null default now(),
 primary key(proposal_id,user_id)
);
create table public.goals (
 id uuid primary key default gen_random_uuid(),
 child_id uuid not null references public.users(id),
 proposal_id uuid not null unique references public.proposals(id),
 product_id uuid not null references public.products(id),
 size text not null check(size in ('small','medium','large')),
 required_points integer not null check(required_points>=0),
 status text not null default 'active' check(status in ('active','achieved','requested','completed','cancelled')),
 created_at timestamptz not null default now()
);
create table public.tasks (
 id uuid primary key default gen_random_uuid(),
 family_id uuid not null references public.families(id),
 title text not null,
 description text,
 category text not null check(category in ('study','chore','other')),
 difficulty integer not null check(difficulty between 1 and 5),
 reward_points integer not null check(reward_points>=0),
 schedule_rule text,
 created_by uuid not null references public.users(id),
 active boolean not null default true,
 created_at timestamptz not null default now()
);
create table public.task_assignments (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references public.tasks(id),
 child_id uuid not null references public.users(id),
 assigned_for date,
 due_at timestamptz,
 status text not null default 'assigned' check(status in ('assigned','submitted','approved','rejected','cancelled')),
 created_at timestamptz not null default now()
);
create table public.task_submissions (
 id uuid primary key default gen_random_uuid(),
 assignment_id uuid not null references public.task_assignments(id),
 child_id uuid not null references public.users(id),
 answer_text text,
 evidence_url text,
 submitted_at timestamptz not null default now()
);
create table public.task_reviews (
 id uuid primary key default gen_random_uuid(),
 submission_id uuid not null unique references public.task_submissions(id),
 reviewer_id uuid not null references public.users(id),
 decision text not null check(decision in ('approved','rejected')),
 comment text,
 reviewed_at timestamptz not null default now()
);
create table public.questions (
 id uuid primary key default gen_random_uuid(),
 task_id uuid references public.tasks(id),
 question_text text not null,
 correct_answer text not null,
 difficulty integer not null check(difficulty between 1 and 5),
 grade_level integer check(grade_level between 1 and 12),
 created_at timestamptz not null default now()
);
create table public.quiz_attempts (
 id uuid primary key default gen_random_uuid(),
 question_id uuid not null references public.questions(id),
 child_id uuid not null references public.users(id),
 answer_text text not null,
 is_correct boolean not null,
 attempted_at timestamptz not null default now()
);
create table public.point_transactions (
 id uuid primary key default gen_random_uuid(),
 child_id uuid not null references public.users(id),
 delta_points integer not null check(delta_points<>0),
 reason text not null,
 task_review_id uuid references public.task_reviews(id),
 goal_id uuid references public.goals(id),
 created_at timestamptz not null default now()
);
create index point_transactions_child_idx on public.point_transactions(child_id,created_at);
create table public.purchase_requests (
 id uuid primary key default gen_random_uuid(),
 goal_id uuid not null references public.goals(id),
 child_id uuid not null references public.users(id),
 parent_id uuid not null references public.users(id),
 status text not null default 'pending' check(status in ('pending','approved','rejected','purchased','cancelled')),
 requested_at timestamptz not null default now(),
 decided_at timestamptz
);
create table public.notifications (
 id uuid primary key default gen_random_uuid(),
 recipient_id uuid not null references public.users(id) on delete cascade,
 kind text not null,
 title text not null,
 body text,
 read_at timestamptz,
 created_at timestamptz not null default now()
);

-- RLS: fail closed. No client access until explicit policies are added.
-- The application server must validate auth.uid() and membership on every privileged operation.
do $$ declare t text; begin
 foreach t in array array['users','families','family_members','invitations','conversations','messages','user_preferences','shared_conditions','negotiations','products','proposals','proposal_approvals','goals','tasks','task_assignments','task_submissions','task_reviews','questions','quiz_attempts','point_transactions','purchase_requests','notifications'] loop
  execute format('alter table public.%I enable row level security',t);
 end loop;
end $$;
-- Baseline read access for a user's own profile and private chat (no writes from browser).
create policy users_read_self on public.users for select to authenticated using(id=(select auth.uid()));
create policy preferences_read_self on public.user_preferences for select to authenticated using(user_id=(select auth.uid()));
create policy conversations_read_self on public.conversations for select to authenticated using(user_id=(select auth.uid()));
create policy messages_read_self on public.messages for select to authenticated using(
 exists(select 1 from public.conversations c where c.id=messages.conversation_id and c.user_id=(select auth.uid()))
);
create policy notifications_read_self on public.notifications for select to authenticated using(recipient_id=(select auth.uid()));
-- Add narrowly scoped RLS policies or verified Edge Functions for other reads/writes.
-- NEVER expose a service_role key to the browser.
