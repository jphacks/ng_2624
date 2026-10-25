begin;
-- Parents participate only in a shared negotiation following a child's submission.
alter function public.wb_consultation_phase(uuid,uuid) rename to wb_consultation_phase_v1;
create function public.wb_consultation_phase(p_actor_id uuid,p_conversation_id uuid) returns text language plpgsql set search_path='' as $$
declare phase text; begin
 phase:=public.wb_consultation_phase_v1(p_actor_id,p_conversation_id);
 if exists(select 1 from public.users where id=p_actor_id and role='parent') then return 'closed'; end if;
 return phase;
end $$;

-- Begin the post-selection conversation without another model call or fabricated user message.
alter function public.wb_select_product(uuid,uuid,uuid) rename to wb_select_product_v2;
create function public.wb_select_product(p_actor_id uuid,p_conversation_id uuid,p_product_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare previous uuid; result jsonb; candidate jsonb; begin
 select selected_product_id into previous from public.conversations where id=p_conversation_id for update;
 result:=public.wb_select_product_v2(p_actor_id,p_conversation_id,p_product_id);
 if previous is distinct from p_product_id then
 select value into candidate from jsonb_array_elements(result->'products') where value->>'id'=p_product_id::text;
 insert into public.messages(conversation_id,sender,content,response_type)
 values(p_conversation_id,'assistant','「'||(candidate->>'name')||'」だね。この商品のどんなところが気に入った？ おうちの人に伝える、ほしい理由を教えてね。','HEARING');
 end if;
 return result;
end $$;

-- A final decline closes the proposal. Only a request to discuss terms opens shared chat.
create or replace function public.wb_review_proposal(p_actor_id uuid,p_proposal_id uuid,p_expected_version integer,p_decision text,p_comment text default null)
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
 if p_decision<>'approved' and nullif(trim(p_comment),'') is null then raise exception 'A reason is required'; end if;
 insert into public.proposal_approvals(proposal_id,user_id,decision,comment) values(p.id,p_actor_id,p_decision,p_comment);
 if p_decision<>'approved' then
 update public.proposals set status='rejected' where id=p.id returning * into p;
 update public.negotiations set status=case when p_decision='rejected' then 'closed' else 'revision_requested' end where id=n.id;
 elsif (select count(*) from public.proposal_approvals where proposal_id=p.id and user_id in (n.child_id,n.parent_id) and decision='approved')=2 then
 perform 1 from public.users where id=n.child_id for update;
 update public.proposals set status='agreed' where id=p.id returning * into p;
 update public.negotiations set status='agreed' where id=n.id;
 end if;
 return to_jsonb(p);
end $$;

do $$ declare r record; begin
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'wb\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);
 execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
