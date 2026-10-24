-- Apply atomically. All wb_* functions are SECURITY INVOKER and service-role only.
-- Actor IDs come only from the same-origin server's verified sessions.
begin;
alter table public.conversations add column child_id uuid references public.users(id), add column latest_ai_output jsonb, add column products jsonb not null default '[]', add column selected_product_id uuid references public.products(id);
alter table public.negotiations add column parent_id uuid references public.users(id), add column latest_ai_output jsonb, add column products jsonb not null default '[]', add column selected_product_id uuid references public.products(id);
alter table public.proposals alter column negotiation_id drop not null;
alter table public.proposals add column conversation_id uuid references public.conversations(id);
create table public.negotiation_messages (id uuid primary key default gen_random_uuid(), negotiation_id uuid not null references public.negotiations(id) on delete cascade, sender text not null check(sender in ('user','assistant','system')), user_id uuid references public.users(id), content text not null, created_at timestamptz not null default now());
create table public.app_sessions (token_hash text primary key, user_id uuid not null references public.users(id) on delete cascade, csrf_token text not null, created_at timestamptz not null default now(), last_active_at timestamptz not null default now(), expires_at timestamptz not null, reauthenticated_at timestamptz, revoked_at timestamptz, device_label text);
create table public.app_invitations (id uuid primary key default gen_random_uuid(), token_hash text not null unique, child_id uuid not null references public.users(id), parent_id uuid not null references public.users(id), family_id uuid not null references public.families(id), expires_at timestamptz not null, used_at timestamptz, created_at timestamptz not null default now());
create table public.app_pairing_requests (id uuid primary key default gen_random_uuid(), token_hash text not null unique, invitation_id uuid not null references public.app_invitations(id), confirmation_code text not null, status text not null default 'pending' check(status in ('pending','approved','completed','rejected')), expires_at timestamptz not null, created_at timestamptz not null default now(), approved_at timestamptz, completed_at timestamptz);
create table public.chore_requests (id uuid primary key default gen_random_uuid(), family_id uuid not null references public.families(id), child_id uuid not null references public.users(id), requested_by uuid not null references public.users(id), title text not null check(length(trim(title)) between 1 and 200), description text, reward_amount_yen integer not null check(reward_amount_yen between 0 and 1000000), due_at timestamptz, status text not null default 'pending' check(status in ('pending','approved','rejected')), assignment_id uuid references public.task_assignments(id), reviewed_by uuid references public.users(id), review_comment text, created_at timestamptz not null default now(), reviewed_at timestamptz);
create table public.child_settings (child_id uuid primary key references public.users(id), parent_id uuid references public.users(id), reward_guidelines jsonb not null default '{}', constraints jsonb not null default '{}', updated_at timestamptz not null default now());
create unique index amount_transactions_review_unique on public.amount_transactions(task_review_id) where task_review_id is not null;
create index app_sessions_user_idx on public.app_sessions(user_id);
create index negotiation_messages_order_idx on public.negotiation_messages(negotiation_id,created_at);
create index proposals_conversation_idx on public.proposals(conversation_id);
do $$ declare t text; begin
 foreach t in array array['app_sessions','app_invitations','app_pairing_requests','chore_requests','child_settings','negotiation_messages'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
revoke all on function public.review_proposal(uuid,text,text) from public,anon,authenticated;

create function public.wb_family(p_actor_id uuid,p_child_id uuid) returns uuid language plpgsql set search_path='' as $$
declare f uuid; begin
 select c.family_id into f from public.family_members c join public.users cu on cu.id=c.user_id and cu.role='child'
 join public.family_members a on a.family_id=c.family_id and a.user_id=p_actor_id join public.users au on au.id=a.user_id and au.role=a.family_role
 where c.user_id=p_child_id and c.family_role='child' and (p_actor_id=p_child_id or a.family_role='parent') order by c.joined_at limit 1;
 if f is null then raise exception 'Family access denied' using errcode='42501'; end if; return f;
end $$;
create function public.wb_register_parent(p_user_id uuid,p_display_name text) returns jsonb language plpgsql set search_path='' as $$
declare f uuid; u public.users; begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
 insert into public.users(id,display_name,role,onboarding_completed) values(p_user_id,p_display_name,'parent',true) on conflict(id) do nothing;
 select * into u from public.users where id=p_user_id;
 if u.role<>'parent' then raise exception 'Parent account required'; end if;
 select family_id into f from public.family_members where user_id=p_user_id and family_role='parent' order by joined_at limit 1;
 if f is null then
 insert into public.families(name,created_by) values(p_display_name||'の家族',p_user_id) returning id into f;
 insert into public.family_members(family_id,user_id,family_role) values(f,p_user_id,'parent'); end if;
 return jsonb_build_object('user',to_jsonb(u),'family_id',f);
end $$;
create function public.wb_create_chore(p_actor_id uuid,p_child_id uuid,p_title text,p_description text,p_reward_amount_yen integer,p_due_at timestamptz) returns jsonb language plpgsql set search_path='' as $$
declare f uuid; r public.chore_requests; t uuid; a uuid; begin
 f:=public.wb_family(p_actor_id,p_child_id);
 insert into public.chore_requests(family_id,child_id,requested_by,title,description,reward_amount_yen,due_at) values(f,p_child_id,p_actor_id,p_title,p_description,p_reward_amount_yen,p_due_at) returning * into r;
 if p_actor_id<>p_child_id then
 insert into public.tasks(family_id,title,description,category,difficulty,reward_amount_yen,created_by) values(f,p_title,p_description,'chore',1,p_reward_amount_yen,p_actor_id) returning id into t;
 insert into public.task_assignments(task_id,child_id,due_at) values(t,p_child_id,p_due_at) returning id into a;
 update public.chore_requests set status='approved',assignment_id=a,reviewed_by=p_actor_id,reviewed_at=now() where id=r.id returning * into r;
 end if; return to_jsonb(r);
end $$;
create function public.wb_review_chore_request(p_actor_id uuid,p_request_id uuid,p_decision text,p_reward_amount_yen integer,p_due_at timestamptz,p_title text default null,p_comment text default null) returns jsonb language plpgsql set search_path='' as $$
declare r public.chore_requests; t uuid; a uuid; begin
 select * into r from public.chore_requests where id=p_request_id for update;
 if not found then raise exception 'Request not found'; end if;
 if public.wb_family(p_actor_id,r.child_id)<>r.family_id or p_actor_id=r.child_id then raise exception 'Parent required'; end if;
 if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
 if r.status<>'pending' then if r.status=p_decision then return to_jsonb(r); end if; raise exception 'Already reviewed'; end if;
 if p_decision='approved' then
 if p_reward_amount_yen is null or p_reward_amount_yen not between 0 and 1000000 then raise exception 'Invalid reward'; end if;
 insert into public.tasks(family_id,title,description,category,difficulty,reward_amount_yen,created_by) values(r.family_id,coalesce(p_title,r.title),r.description,'chore',1,p_reward_amount_yen,p_actor_id) returning id into t;
 insert into public.task_assignments(task_id,child_id,due_at) values(t,r.child_id,p_due_at) returning id into a; end if;
 update public.chore_requests set status=p_decision,assignment_id=a,reviewed_by=p_actor_id,reviewed_at=now(),review_comment=p_comment,title=coalesce(p_title,title),reward_amount_yen=case when p_decision='approved' then p_reward_amount_yen else reward_amount_yen end,due_at=case when p_decision='approved' then p_due_at else due_at end where id=r.id returning * into r;
 return to_jsonb(r);
end $$;
create function public.wb_submit_chore(p_actor_id uuid,p_assignment_id uuid,p_answer_text text) returns jsonb language plpgsql set search_path='' as $$
declare a public.task_assignments; t public.tasks; s public.task_submissions; begin
 select * into a from public.task_assignments where id=p_assignment_id for update;
 if not found or a.child_id<>p_actor_id then raise exception 'Assignment access denied'; end if;
 select * into t from public.tasks where id=a.task_id;
 if public.wb_family(p_actor_id,a.child_id)<>t.family_id or t.category<>'chore' then raise exception 'Invalid chore'; end if;
 if a.status='submitted' then select * into s from public.task_submissions where assignment_id=a.id order by submitted_at desc limit 1; return to_jsonb(s); end if;
 if a.status not in ('assigned','rejected') then raise exception 'Cannot submit this chore'; end if;
 insert into public.task_submissions(assignment_id,child_id,answer_text) values(a.id,p_actor_id,p_answer_text) returning * into s;
 update public.task_assignments set status='submitted' where id=a.id; return to_jsonb(s);
end $$;
create function public.wb_review_chore(p_actor_id uuid,p_assignment_id uuid,p_decision text,p_comment text) returns jsonb language plpgsql set search_path='' as $$
declare a public.task_assignments; t public.tasks; s public.task_submissions; r public.task_reviews; begin
 select * into a from public.task_assignments where id=p_assignment_id for update;
 if not found then raise exception 'Assignment not found'; end if;
 select * into t from public.tasks where id=a.task_id;
 if public.wb_family(p_actor_id,a.child_id)<>t.family_id or p_actor_id=a.child_id or t.category<>'chore' then raise exception 'Parent required'; end if;
 if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
 select * into s from public.task_submissions where assignment_id=a.id order by submitted_at desc,id desc limit 1;
 if not found then raise exception 'Submission required'; end if;
 select * into r from public.task_reviews where submission_id=s.id;
 if found then if r.decision=p_decision then return to_jsonb(r); end if; raise exception 'Already reviewed'; end if;
 if a.status<>'submitted' then raise exception 'Not submitted'; end if;
 insert into public.task_reviews(submission_id,reviewer_id,decision,comment) values(s.id,p_actor_id,p_decision,p_comment) returning * into r;
 update public.task_assignments set status=p_decision where id=a.id;
 if p_decision='approved' and t.reward_amount_yen>0 then insert into public.amount_transactions(child_id,delta_amount_yen,reason,task_review_id) values(a.child_id,t.reward_amount_yen,t.title,r.id); end if;
 return to_jsonb(r);
end $$;

create function public.wb_create_invitation(p_actor_id uuid,p_child_id uuid,p_token_hash text) returns jsonb language plpgsql set search_path='' as $$
declare f uuid; i public.app_invitations; begin
 perform 1 from public.users where id=p_child_id for update;
 f:=public.wb_family(p_actor_id,p_child_id);
 if p_actor_id=p_child_id then raise exception 'Parent required'; end if;
 update public.app_invitations set expires_at=now() where child_id=p_child_id and expires_at>now();
 insert into public.app_invitations(token_hash,child_id,parent_id,family_id,expires_at) values(p_token_hash,p_child_id,p_actor_id,f,now()+interval '10 minutes') returning * into i;
 return to_jsonb(i);
end $$;
create function public.wb_request_pairing(p_invitation_hash text,p_token_hash text) returns jsonb language plpgsql set search_path='' as $$
declare i public.app_invitations; r public.app_pairing_requests; begin
 select * into i from public.app_invitations where token_hash=p_invitation_hash for update;
 if not found or i.expires_at<=now() then raise exception 'Invitation expired'; end if;
 select * into r from public.app_pairing_requests where token_hash=p_token_hash and invitation_id=i.id;
 if found then return to_jsonb(r); end if;
 if i.used_at is not null then raise exception 'Invitation already used'; end if;
 insert into public.app_pairing_requests(token_hash,invitation_id,confirmation_code,expires_at)
 values(p_token_hash,i.id,lpad((floor(random()*1000000))::integer::text,6,'0'),i.expires_at) returning * into r;
 update public.app_invitations set used_at=now() where id=i.id; return to_jsonb(r);
end $$;
create function public.wb_approve_pairing(p_actor_id uuid,p_request_id uuid,p_confirmation_code text) returns jsonb language plpgsql set search_path='' as $$
declare i public.app_invitations; r public.app_pairing_requests; begin
 select * into r from public.app_pairing_requests where id=p_request_id for update;
 if not found then raise exception 'Pairing not found'; end if;
 select * into i from public.app_invitations where id=r.invitation_id;
 if public.wb_family(p_actor_id,i.child_id)<>i.family_id or p_actor_id<>i.parent_id then raise exception 'Inviting parent required'; end if;
 if r.confirmation_code<>p_confirmation_code or p_confirmation_code is null then raise exception 'Confirmation code mismatch'; end if;
 if r.expires_at<=now() or i.expires_at<=now() then raise exception 'Pairing expired'; end if;
 if r.status='approved' then return to_jsonb(r); end if;
 if r.status<>'pending' then raise exception 'Pairing unavailable'; end if;
 update public.app_pairing_requests set status='approved',approved_at=now() where id=r.id returning * into r; return to_jsonb(r);
end $$;
create function public.wb_complete_pairing(p_request_id uuid,p_token_hash text,p_session_token_hash text,p_csrf_token text) returns jsonb language plpgsql set search_path='' as $$
declare i public.app_invitations; r public.app_pairing_requests; s public.app_sessions; begin
 select * into r from public.app_pairing_requests where id=p_request_id and token_hash=p_token_hash for update;
 if not found or r.status<>'approved' or r.expires_at<=now() then raise exception 'Pairing unavailable'; end if;
 select * into i from public.app_invitations where id=r.invitation_id;
 if i.expires_at<=now() or public.wb_family(i.parent_id,i.child_id)<>i.family_id then raise exception 'Invitation unavailable'; end if;
 insert into public.app_sessions(token_hash,user_id,csrf_token,expires_at,device_label) values(p_session_token_hash,i.child_id,p_csrf_token,now()+interval '30 days','子どもの端末') returning * into s;
 update public.app_pairing_requests set status='completed',completed_at=now() where id=r.id; return to_jsonb(s);
end $$;

-- Function privileges are finalized before COMMIT, never briefly public.
do $$ declare r record; begin
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'wb\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);
 execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
