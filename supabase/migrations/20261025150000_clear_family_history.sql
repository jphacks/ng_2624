begin;
-- Account, family, preference and device records are deliberately outside this reset.
create function public.wb_clear_family_history(p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare families uuid[]; kids uuid[]; chats uuid[]; negotiation_ids uuid[]; task_ids uuid[]; product_ids uuid[];
begin
 if not exists(select 1 from public.users where id=p_actor_id and role='parent') then
  raise exception 'Parent required' using errcode='42501';
 end if;
 select coalesce(array_agg(family_id),'{}') into families from public.family_members where user_id=p_actor_id and family_role='parent';
 if cardinality(families)=0 then raise exception 'Family required' using errcode='42501'; end if;
 select coalesce(array_agg(distinct user_id),'{}') into kids from public.family_members where family_id=any(families) and family_role='child';
 -- Serialize against purchases, rewards, and writes referencing these accounts.
 perform 1 from public.users where id=p_actor_id or id=any(kids) order by id for update;
 perform 1 from public.conversations where child_id=any(kids) or user_id=any(kids) or (user_id=p_actor_id and child_id is null) order by id for update;
 perform 1 from public.negotiations where family_id=any(families) order by id for update;
 select coalesce(array_agg(id),'{}') into chats from public.conversations where child_id=any(kids) or user_id=any(kids) or (user_id=p_actor_id and child_id is null);
 select coalesce(array_agg(id),'{}') into negotiation_ids from public.negotiations where family_id=any(families);
 if exists(select 1 from public.conversations where id=any(chats) and ai_lock_id is not null and ai_lock_expires_at>now())
 or exists(select 1 from public.negotiations where id=any(negotiation_ids) and ai_lock_id is not null and ai_lock_expires_at>now()) then
  raise exception 'History is busy; wait for AI to finish';
 end if;
 select coalesce(array_agg(id),'{}') into task_ids from public.tasks where family_id=any(families);
 select coalesce(array_agg(distinct product_id),'{}') into product_ids from (
  select product_id from public.proposals where conversation_id=any(chats) or negotiation_id=any(negotiation_ids)
  union select product_id from public.goals where child_id=any(kids)
  union select (x->>'id')::uuid from public.conversations c cross join lateral jsonb_array_elements(c.products) x where c.id=any(chats)
  union select (x->>'id')::uuid from public.negotiations n cross join lateral jsonb_array_elements(n.products) x where n.id=any(negotiation_ids)
 ) candidates;
 delete from public.ai_requests where conversation_id=any(chats) or user_id=any(kids) or user_id=p_actor_id;
 delete from public.notifications where recipient_id=any(kids) or recipient_id=p_actor_id;
 delete from public.shared_conditions where family_id=any(families);
 delete from public.amount_transactions where child_id=any(kids);
 delete from public.purchase_requests where child_id=any(kids) or goal_id in(select id from public.goals where child_id=any(kids));
 delete from public.goals where child_id=any(kids);
 delete from public.quiz_attempts where child_id=any(kids) or question_id in(select id from public.questions where task_id=any(task_ids));
 delete from public.questions where task_id=any(task_ids);
 delete from public.chore_requests where family_id=any(families);
 delete from public.task_reviews where submission_id in(select s.id from public.task_submissions s join public.task_assignments a on a.id=s.assignment_id where a.task_id=any(task_ids));
 delete from public.task_submissions where assignment_id in(select id from public.task_assignments where task_id=any(task_ids));
 delete from public.task_assignments where task_id=any(task_ids);
 delete from public.tasks where id=any(task_ids);
 update public.conversations set context_proposal_id=null where id=any(chats);
 delete from public.proposals where conversation_id=any(chats) or negotiation_id=any(negotiation_ids);
 delete from public.negotiations where id=any(negotiation_ids);
 delete from public.conversations where id=any(chats);
 -- Remove only the deleted family's orphaned search results, never shared products.
 delete from public.products p where p.id=any(product_ids)
 and not exists(select 1 from public.proposals q where q.product_id=p.id)
 and not exists(select 1 from public.goals g where g.product_id=p.id)
 and not exists(select 1 from public.conversations c where c.selected_product_id=p.id or c.products @> jsonb_build_array(jsonb_build_object('id',p.id::text)))
 and not exists(select 1 from public.negotiations n where n.selected_product_id=p.id or n.products @> jsonb_build_array(jsonb_build_object('id',p.id::text)));
 return jsonb_build_object('cleared',true);
end $$;
revoke all on function public.wb_clear_family_history(uuid) from public,anon,authenticated;
grant execute on function public.wb_clear_family_history(uuid) to service_role;
commit;
