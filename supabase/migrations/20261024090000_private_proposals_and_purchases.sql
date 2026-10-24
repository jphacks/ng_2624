begin;
alter table public.users add column birth_date date, add column gender text, add column grade_base_school_year integer;
alter table public.child_settings add column chore_preferences jsonb not null default '{}';
alter table public.proposals add column goal_size text check(goal_size in ('small','medium','large')), add column agreed_amount_yen integer check(agreed_amount_yen>=0);
-- Existing historical amounts are preserved. New chore terms must use ten-yen increments.
create function public.wb_check_chore_reward() returns trigger language plpgsql set search_path='' as $$ begin
 if new.reward_amount_yen%10<>0 then raise exception 'Reward must be a multiple of 10 yen'; end if; return new;
end $$;
create trigger wb_chore_reward before insert or update of reward_amount_yen on public.chore_requests for each row execute function public.wb_check_chore_reward();
create trigger wb_task_reward before insert or update of reward_amount_yen on public.tasks for each row when(new.category='chore') execute function public.wb_check_chore_reward();

create function public.wb_save_proposal(p_actor_id uuid,p_conversation_id uuid,p_product_id uuid,p_persuasion_text text,p_purchase_conditions text[],p_goal_size text,p_proposal_id uuid default null,p_expected_version integer default null,p_based_on_proposal_id uuid default null)
returns jsonb language plpgsql set search_path='' as $$
declare c public.conversations; p public.proposals; b public.proposals; n public.negotiations; v integer; begin
 select * into c from public.conversations where id=p_conversation_id and user_id=p_actor_id for update;
 if not found then raise exception 'Private conversation access denied'; end if;
 if p_goal_size is null or p_goal_size not in ('small','medium','large') or length(trim(coalesce(p_persuasion_text,'')))=0 then raise exception 'Invalid proposal'; end if;
 -- Product must have been returned by this private conversation, or be its selected product.
 if c.selected_product_id is distinct from p_product_id and not exists(select 1 from jsonb_array_elements(c.products) x where x->>'id'=p_product_id::text) then raise exception 'Product not in private conversation'; end if;
 if p_proposal_id is not null then
 select * into p from public.proposals where id=p_proposal_id for update;
 if not found or p.proposed_by<>p_actor_id or p.conversation_id is distinct from c.id or p.status<>'draft' then raise exception 'Draft access denied'; end if;
 if p_expected_version is null or p.version<>p_expected_version then raise exception 'Stale proposal version'; end if;
 -- Editing changes the version shown to the sender; no approvals exist for drafts.
 update public.proposals set product_id=p_product_id,persuasion_text=p_persuasion_text,purchase_conditions=coalesce(p_purchase_conditions,'{}'),goal_size=p_goal_size,version=version+1 where id=p.id returning * into p;
 else
 v:=1;
 if p_based_on_proposal_id is not null then
 select * into b from public.proposals where id=p_based_on_proposal_id;
 select * into n from public.negotiations where id=b.negotiation_id for update;
 if n.id is null or p_actor_id not in (n.child_id,n.parent_id) or n.parent_id is null then raise exception 'Proposal access denied'; end if;
 if public.wb_family(p_actor_id,n.child_id)<>n.family_id or n.status in ('agreed','closed') then raise exception 'Cannot revise negotiation'; end if;
 if b.status='draft' or b.status='superseded' then raise exception 'Cannot revise private or outdated draft'; end if;
 -- Drafts stay detached so their contents/version do not become shared before send.
 v:=b.version+1;
 end if;
 insert into public.proposals(conversation_id,product_id,version,proposed_by,persuasion_text,purchase_conditions,goal_size,based_on_proposal_id,based_on_version)
 values(c.id,p_product_id,v,p_actor_id,p_persuasion_text,coalesce(p_purchase_conditions,'{}'),p_goal_size,b.id,b.version) returning * into p;
 end if;
 return to_jsonb(p);
end $$;

create function public.wb_send_proposal(p_actor_id uuid,p_proposal_id uuid,p_expected_version integer,p_parent_id uuid default null)
returns jsonb language plpgsql set search_path='' as $$
declare p public.proposals; c public.conversations; n public.negotiations; b public.proposals; child uuid; par uuid; f uuid; price integer; begin
 -- Serialize all proposal operations for an actor, plus negotiation and child locks below.
 select * into p from public.proposals where id=p_proposal_id for update;
 if not found or p.proposed_by<>p_actor_id then raise exception 'Proposal access denied'; end if;
 if p_expected_version is null or p.version<>p_expected_version then raise exception 'Stale proposal version'; end if;
 select * into c from public.conversations where id=p.conversation_id and user_id=p_actor_id;
 if not found then raise exception 'Private conversation required'; end if;
 child:=coalesce(c.child_id,p_actor_id);
 f:=public.wb_family(p_actor_id,child);
 if p_actor_id=child then par:=p_parent_id; else par:=p_actor_id; end if;
 if par is null or par=child or public.wb_family(par,child)<>f then raise exception 'Recipient parent required'; end if;
 if p.status='pending' then return to_jsonb(p); end if;
 if p.status<>'draft' then raise exception 'Draft required'; end if;
 select price_jpy into price from public.products where id=p.product_id;
 if price is null then raise exception 'Product price required'; end if;
 if p.based_on_proposal_id is not null then
 select * into b from public.proposals where id=p.based_on_proposal_id;
 select * into n from public.negotiations where id=b.negotiation_id for update;
 if n.id is null or n.child_id<>child or n.parent_id<>par or n.family_id<>f or n.status in ('agreed','closed') then raise exception 'Invalid revision recipient'; end if;
 if exists(select 1 from public.proposals where negotiation_id=n.id and version>b.version and status<>'draft') then raise exception 'Revision is based on an outdated proposal'; end if;
 if p.version<=b.version then raise exception 'Revision version must increase'; end if;
 update public.proposals set status='superseded' where negotiation_id=n.id and status in ('pending','rejected');
 else
 insert into public.negotiations(family_id,child_id,parent_id,status) values(f,child,par,'awaiting_approval') returning * into n;
 end if;
 update public.proposals set negotiation_id=n.id,status='pending',agreed_amount_yen=price where id=p.id returning * into p;
 update public.negotiations set status='awaiting_approval' where id=n.id;
 insert into public.proposal_approvals(proposal_id,user_id,decision) values(p.id,p_actor_id,'approved');
 return to_jsonb(p);
end $$;

create function public.wb_review_proposal(p_actor_id uuid,p_proposal_id uuid,p_expected_version integer,p_decision text,p_comment text default null)
returns jsonb language plpgsql set search_path='' as $$
declare p public.proposals; n public.negotiations; prev text; begin
 select * into p from public.proposals where id=p_proposal_id for update;
 if not found then raise exception 'Proposal not found'; end if;
 select * into n from public.negotiations where id=p.negotiation_id for update;
 if n.id is null or n.parent_id is null or p_actor_id not in (n.child_id,n.parent_id) or public.wb_family(p_actor_id,n.child_id)<>n.family_id then raise exception 'Proposal access denied'; end if;
 if p_expected_version is null or p_expected_version<>p.version then raise exception 'Stale proposal version'; end if;
 if p_decision is null or p_decision not in ('approved','rejected','revision_requested') then raise exception 'Invalid decision'; end if;
 select decision into prev from public.proposal_approvals where proposal_id=p.id and user_id=p_actor_id;
 if prev=p_decision then return to_jsonb(p); elsif prev is not null then raise exception 'Already answered this version'; end if;
 if p.status<>'pending' or n.status<>'awaiting_approval' then raise exception 'Proposal is not awaiting approval'; end if;
 if exists(select 1 from public.proposals where negotiation_id=n.id and version>p.version and status<>'draft') then raise exception 'Outdated proposal'; end if;
 insert into public.proposal_approvals(proposal_id,user_id,decision,comment) values(p.id,p_actor_id,p_decision,p_comment);
 if p_decision<>'approved' then
 update public.proposals set status='rejected' where id=p.id returning * into p;
 update public.negotiations set status='revision_requested' where id=n.id;
 elsif (select count(*) from public.proposal_approvals where proposal_id=p.id and user_id in (n.child_id,n.parent_id) and decision='approved')=2 then
 -- Lock child to serialize slot creation, purchase, and all balance changes.
 perform 1 from public.users where id=n.child_id for update;
 update public.proposals set status='agreed' where id=p.id returning * into p;
 update public.negotiations set status='agreed' where id=n.id;
 end if;
 return to_jsonb(p);
end $$;

create or replace function public.create_goal_on_agreement() returns trigger language plpgsql security definer set search_path='' as $$
declare n public.negotiations; sz text; amount integer; begin
 if new.status<>'agreed' or old.status='agreed' then return new; end if;
 select * into n from public.negotiations where id=new.negotiation_id;
 if n.child_id is null then raise exception 'Child required'; end if;
 perform 1 from public.users where id=n.child_id for update;
 amount:=new.agreed_amount_yen;
 if amount is null then select price_jpy into amount from public.products where id=new.product_id; end if;
 if amount is null then raise exception 'Product price required'; end if;
 sz:=coalesce(new.goal_size,case when amount<3000 then 'small' when amount<10000 then 'medium' else 'large' end);
 if exists(select 1 from public.goals where child_id=n.child_id and size=sz and status in ('active','achieved','requested') and proposal_id<>new.id) then raise exception 'An active goal already occupies this size'; end if;
 insert into public.goals(child_id,proposal_id,product_id,size,target_amount_yen) values(n.child_id,new.id,new.product_id,sz,amount) on conflict(proposal_id) do nothing;
 return new;
end $$;
revoke all on function public.create_goal_on_agreement() from public,anon,authenticated;

create function public.wb_purchase_goal(p_actor_id uuid,p_goal_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare g public.goals; bal bigint; begin
 select * into g from public.goals where id=p_goal_id;
 if not found then raise exception 'Goal not found'; end if;
 perform public.wb_family(p_actor_id,g.child_id);
 if p_actor_id=g.child_id then raise exception 'Parent required'; end if;
 -- Child lock serializes purchases for different goals against the same balance.
 perform 1 from public.users where id=g.child_id for update;
 select * into g from public.goals where id=p_goal_id for update;
 if g.status='completed' then return to_jsonb(g); end if;
 if g.status not in ('active','achieved','requested') then raise exception 'Goal unavailable'; end if;
 select coalesce(sum(delta_amount_yen),0) into bal from public.amount_transactions where child_id=g.child_id;
 if bal<g.target_amount_yen then raise exception 'Insufficient balance'; end if;
 if g.target_amount_yen>0 then insert into public.amount_transactions(child_id,delta_amount_yen,reason,goal_id) values(g.child_id,-g.target_amount_yen,'購入済み',g.id); end if;
 update public.goals set status='completed' where id=g.id returning * into g;
 return to_jsonb(g);
end $$;
-- Ensure application function grants remain closed even when Supabase default privileges differ.
do $$ declare r record; begin
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'wb\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);
 execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
