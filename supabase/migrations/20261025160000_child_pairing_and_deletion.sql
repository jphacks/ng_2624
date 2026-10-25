begin;
alter table public.users add column first_paired_at timestamptz;
-- Past sessions count even after expiry/revocation; pairing history is not a live-session flag.
update public.users u set first_paired_at=(select min(t) from (
 select s.created_at t from public.app_sessions s where s.user_id=u.id
 union all select r.completed_at from public.app_pairing_requests r join public.app_invitations i on i.id=r.invitation_id where i.child_id=u.id and r.status='completed'
) history) where u.role='child';
create function public.wb_mark_first_pairing() returns trigger language plpgsql security definer set search_path='' as $$ begin
 update public.users set first_paired_at=coalesce(first_paired_at,new.created_at) where id=new.user_id and role='child';
 return new;
end $$;
create trigger wb_first_pairing after insert on public.app_sessions for each row execute function public.wb_mark_first_pairing();
revoke all on function public.wb_mark_first_pairing() from public,anon,authenticated;

create function public.wb_delete_child(p_actor_id uuid,p_child_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare family uuid; chats uuid[]; negotiation_ids uuid[]; assignment_ids uuid[]; task_ids uuid[]; product_ids uuid[];
begin
 if not exists(select 1 from public.users where id=p_actor_id and role='parent') or not exists(select 1 from public.users where id=p_child_id and role='child') then raise exception 'Parent and child required' using errcode='42501'; end if;
 family:=public.wb_family(p_actor_id,p_child_id);
 -- Do not delete an account belonging to a second family the actor cannot administer.
 if exists(select 1 from public.family_members c where c.user_id=p_child_id and not exists(select 1 from public.family_members p where p.user_id=p_actor_id and p.family_id=c.family_id and p.family_role='parent')) then raise exception 'Child belongs to another family' using errcode='42501'; end if;
 perform 1 from public.users where id in(p_actor_id,p_child_id) order by id for update;
 perform 1 from public.conversations where child_id=p_child_id or user_id=p_child_id order by id for update;
 perform 1 from public.negotiations where child_id=p_child_id order by id for update;
 select coalesce(array_agg(id),'{}') into chats from public.conversations where child_id=p_child_id or user_id=p_child_id;
 select coalesce(array_agg(id),'{}') into negotiation_ids from public.negotiations where child_id=p_child_id;
 if exists(select 1 from public.conversations where id=any(chats) and ai_lock_id is not null and ai_lock_expires_at>now()) or exists(select 1 from public.negotiations where id=any(negotiation_ids) and ai_lock_id is not null and ai_lock_expires_at>now()) then raise exception 'History is busy; wait for AI to finish'; end if;
 select coalesce(array_agg(id),'{}'),coalesce(array_agg(distinct task_id),'{}') into assignment_ids,task_ids from public.task_assignments where child_id=p_child_id;
 select coalesce(array_agg(distinct product_id),'{}') into product_ids from (
 select product_id from public.proposals where conversation_id=any(chats) or negotiation_id=any(negotiation_ids)
 union select product_id from public.goals where child_id=p_child_id
 union select (x->>'id')::uuid from public.conversations c cross join lateral jsonb_array_elements(c.products) x where c.id=any(chats)
 union select (x->>'id')::uuid from public.negotiations n cross join lateral jsonb_array_elements(n.products) x where n.id=any(negotiation_ids)
 ) candidates;
 delete from public.ai_requests where conversation_id=any(chats) or user_id=p_child_id;
 delete from public.shared_conditions where source_user_id=p_child_id or target_user_id=p_child_id;
 delete from public.amount_transactions where child_id=p_child_id;
 delete from public.purchase_requests where child_id=p_child_id;
 delete from public.goals where child_id=p_child_id;
 delete from public.quiz_attempts where child_id=p_child_id;
 delete from public.chore_requests where child_id=p_child_id;
 delete from public.task_reviews where submission_id in(select id from public.task_submissions where assignment_id=any(assignment_ids));
 delete from public.task_submissions where assignment_id=any(assignment_ids);
 delete from public.task_assignments where id=any(assignment_ids);
 -- Shared task templates still used by siblings are preserved.
 task_ids:=array(select t.id from public.tasks t where (t.id=any(task_ids) or t.created_by=p_child_id) and not exists(select 1 from public.task_assignments a where a.task_id=t.id) and not exists(select 1 from public.questions q join public.quiz_attempts a on a.question_id=q.id where q.task_id=t.id and a.child_id<>p_child_id));
 delete from public.quiz_attempts where question_id in(select id from public.questions where task_id=any(task_ids));
 delete from public.questions where task_id=any(task_ids);
 delete from public.tasks where id=any(task_ids);
 update public.tasks set created_by=p_actor_id where created_by=p_child_id;
 update public.conversations set context_proposal_id=null where id=any(chats);
 delete from public.proposal_approvals where user_id=p_child_id;
 delete from public.proposals where conversation_id=any(chats) or negotiation_id=any(negotiation_ids);
 delete from public.negotiations where id=any(negotiation_ids);
 delete from public.conversations where id=any(chats);
 delete from public.app_pairing_requests where invitation_id in(select id from public.app_invitations where child_id=p_child_id);
 delete from public.app_invitations where child_id=p_child_id;
 delete from public.family_join_requests where child_id=p_child_id;
 update public.invitations set redeemed_by=null where redeemed_by=p_child_id;
 delete from public.child_settings where child_id=p_child_id;
 -- Deletes the synthetic child account, cascading preferences, memberships, sessions and notifications.
 delete from auth.users where id=p_child_id;
 delete from public.products p where p.id=any(product_ids)
 and not exists(select 1 from public.proposals q where q.product_id=p.id)
 and not exists(select 1 from public.goals g where g.product_id=p.id)
 and not exists(select 1 from public.conversations c where c.selected_product_id=p.id or c.products @> jsonb_build_array(jsonb_build_object('id',p.id::text)))
 and not exists(select 1 from public.negotiations n where n.selected_product_id=p.id or n.products @> jsonb_build_array(jsonb_build_object('id',p.id::text)));
 return jsonb_build_object('childId',p_child_id,'deleted',true);
end $$;
revoke all on function public.wb_delete_child(uuid,uuid) from public,anon,authenticated;
grant execute on function public.wb_delete_child(uuid,uuid) to service_role;
commit;
