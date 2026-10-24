begin;
-- Aggregate in PostgreSQL, not over a paginated API response.
create function public.wb_dashboard_totals(p_actor_id uuid,p_child_id uuid) returns jsonb
language plpgsql set search_path='' as $$
declare balance bigint; earned bigint; pace numeric; begin
 perform public.wb_family(p_actor_id,p_child_id);
 select coalesce(sum(delta_amount_yen),0),coalesce(sum(delta_amount_yen) filter(where delta_amount_yen>0),0),
 coalesce(sum(delta_amount_yen) filter(where delta_amount_yen>0 and created_at>=now()-interval '14 days'),0)/2.0
 into balance,earned,pace from public.amount_transactions where child_id=p_child_id;
 return jsonb_build_object('balanceYen',balance,'lifetimeEarnedYen',earned,'weeklyPaceYen',round(pace));
end $$;
revoke all on function public.wb_dashboard_totals(uuid,uuid) from public,anon,authenticated;
grant execute on function public.wb_dashboard_totals(uuid,uuid) to service_role;

create or replace function public.wb_register_parent(p_user_id uuid,p_display_name text) returns jsonb language plpgsql set search_path='' as $$
declare f uuid; u public.users; begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
 insert into public.users(id,display_name,role,onboarding_completed) values(p_user_id,p_display_name,'parent',false) on conflict(id) do nothing;
 select * into u from public.users where id=p_user_id;
 if u.role<>'parent' then raise exception 'Parent account required'; end if;
 select family_id into f from public.family_members where user_id=p_user_id and family_role='parent' order by joined_at limit 1;
 if f is null then
 insert into public.families(name,created_by) values(p_display_name||'の家族',p_user_id) returning id into f;
 insert into public.family_members(family_id,user_id,family_role) values(f,p_user_id,'parent'); end if;
 return jsonb_build_object('user',to_jsonb(u),'family_id',f);
end $$;
revoke all on function public.wb_register_parent(uuid,text) from public,anon,authenticated;
grant execute on function public.wb_register_parent(uuid,text) to service_role;
-- New application functions run as the server's service role; browsers retain their existing RLS reads only.
grant select,insert,update,delete on public.users,public.families,public.family_members,public.user_preferences,
 public.conversations,public.messages,public.products,public.proposals,public.proposal_approvals,public.negotiations,
 public.goals,public.tasks,public.task_assignments,public.task_submissions,public.task_reviews,public.amount_transactions
 to service_role;
-- Deterministic ordering of messages saved in the same transaction; UUID order is not time order.
alter table public.messages add column sequence_no bigint generated always as identity;
grant usage,select on sequence public.messages_sequence_no_seq to service_role;
create index wb_messages_sequence on public.messages(conversation_id,sequence_no);
alter table public.conversations add column updated_at timestamptz not null default now();
create function public.wb_touch_conversation() returns trigger language plpgsql set search_path='' as $$ begin
 update public.conversations set updated_at=clock_timestamp() where id=new.conversation_id; return new;
end $$;
create trigger wb_message_touch after insert on public.messages for each row execute function public.wb_touch_conversation();
revoke all on function public.wb_touch_conversation() from public,anon,authenticated;
grant execute on function public.wb_touch_conversation() to service_role;
commit;
