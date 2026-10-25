begin;
alter table public.conversations add column reason_draft jsonb, add column reason_confirmed boolean not null default false;

alter function public.wb_finish_ai(uuid,uuid,uuid,text,jsonb) rename to wb_finish_ai_before_reason;
create function public.wb_finish_ai(p_actor_id uuid,p_conversation_id uuid,p_lock_id uuid,p_message text,p_output jsonb) returns jsonb language plpgsql set search_path='' as $$
declare d jsonb; result jsonb; begin
 d:=nullif(p_output->'proposalDraft','null'::jsonb);
 if d is not null then
 if nullif(trim(d->>'persuasionText'),'') is null or not exists(select 1 from public.conversations c,jsonb_array_elements(c.products) x where c.id=p_conversation_id and x->>'id'=d->>'productId' and c.selected_product_id::text=d->>'productId') then raise exception 'Draft product not in conversation'; end if;
 p_output:=(p_output-'proposalDraft')||jsonb_build_object('action','HEARING','reply','「'||(d->>'persuasionText')||'」という理由で合ってる？');
 end if;
 result:=public.wb_finish_ai_before_reason(p_actor_id,p_conversation_id,p_lock_id,p_message,p_output);
 update public.conversations set reason_draft=d,reason_confirmed=false where id=p_conversation_id returning to_jsonb(conversations.*) into result;
 return result;
end $$;

create function public.wb_confirm_reason(p_actor_id uuid,p_conversation_id uuid,p_reason text) returns jsonb language plpgsql set search_path='' as $$
declare c public.conversations; d jsonb; x jsonb; p public.proposals; begin
 select * into c from public.conversations where id=p_conversation_id and user_id=p_actor_id for update;
 if not found or not exists(select 1 from public.users where id=p_actor_id and role='child') then raise exception 'Private child conversation required'; end if;
 if public.wb_consultation_phase(p_actor_id,c.id)<>'consultation' then raise exception 'Consultation is closed'; end if;
 if c.ai_lock_id is not null and c.ai_lock_expires_at>now() then raise exception 'Conversation is busy'; end if;
 d:=c.reason_draft;
 if d is null or d->>'persuasionText' is distinct from p_reason or d->>'productId' is distinct from c.selected_product_id::text then raise exception 'Stale reason summary'; end if;
 if c.reason_confirmed then return to_jsonb(c); end if;
 select value into x from jsonb_array_elements(c.products) where value->>'id'=c.selected_product_id::text;
 select * into p from public.proposals where conversation_id=c.id and proposed_by=p_actor_id and status='draft' order by created_at desc limit 1;
 perform public.wb_save_proposal(p_actor_id,c.id,c.selected_product_id,p_reason,'{}',x->>'size',p.id,p.version,null);
 insert into public.messages(conversation_id,sender,content) values(c.id,'user','この理由で合ってる');
 update public.conversations set reason_confirmed=true where id=c.id returning * into c;
 return to_jsonb(c);
end $$;

alter function public.wb_select_product(uuid,uuid,uuid) rename to wb_select_product_before_reason;
create function public.wb_select_product(p_actor_id uuid,p_conversation_id uuid,p_product_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare result jsonb; begin
 result:=public.wb_select_product_before_reason(p_actor_id,p_conversation_id,p_product_id);
 update public.conversations set reason_draft=null,reason_confirmed=false,latest_ai_output=null where id=p_conversation_id returning to_jsonb(conversations.*) into result;
 return result;
end $$;

-- Recheck the exact reason and selected product at send time, including stale tabs.
alter function public.wb_send_proposal(uuid,uuid,integer,uuid) rename to wb_send_proposal_before_reason;
create function public.wb_send_proposal(p_actor_id uuid,p_proposal_id uuid,p_expected_version integer,p_parent_id uuid default null) returns jsonb language plpgsql set search_path='' as $$
declare p public.proposals; c public.conversations; begin
 select * into p from public.proposals where id=p_proposal_id;
 if p.id is null or p.proposed_by<>p_actor_id then raise exception 'Proposal access denied'; end if;
 if p.version is distinct from p_expected_version then raise exception 'Stale proposal version'; end if;
 select * into c from public.conversations where id=p.conversation_id for update;
 if p.status='draft' and p.based_on_proposal_id is null and (not c.reason_confirmed or c.reason_draft->>'persuasionText' is distinct from p.persuasion_text or c.selected_product_id is distinct from p.product_id) then raise exception 'Child must confirm the reason'; end if;
 return public.wb_send_proposal_before_reason(p_actor_id,p_proposal_id,p_expected_version,p_parent_id);
end $$;

create function public.wb_decide_negotiation(p_actor_id uuid,p_negotiation_id uuid,p_expected_version integer,p_decision text,p_comment text default null) returns jsonb language plpgsql set search_path='' as $$
declare n public.negotiations; p public.proposals; begin
 select * into n from public.negotiations where id=p_negotiation_id for update;
 if n.parent_id is distinct from p_actor_id or public.wb_family(p_actor_id,n.child_id)<>n.family_id then raise exception 'Parent required'; end if;
 select * into p from public.proposals where negotiation_id=n.id and status<>'draft' order by version desc limit 1 for update;
 if p.version is distinct from p_expected_version then raise exception 'Stale proposal version'; end if;
 if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
 if n.status=(case when p_decision='approved' then 'agreed' else 'closed' end) then return to_jsonb(n); end if;
 if p_decision='rejected' and nullif(trim(p_comment),'') is null then raise exception 'A reason is required'; end if;
 if n.status<>'revision_requested' then raise exception 'Shared consultation is closed'; end if;
 if n.ai_lock_id is not null and n.ai_lock_expires_at>now() then raise exception 'Negotiation is busy'; end if;
 insert into public.proposal_approvals(proposal_id,user_id,decision,comment) values(p.id,p_actor_id,p_decision,p_comment)
 on conflict(proposal_id,user_id) do update set decision=excluded.decision,comment=excluded.comment,decided_at=now();
 update public.proposals set status=case when p_decision='approved' then 'agreed' else 'rejected' end where id=p.id;
 update public.negotiations set status=case when p_decision='approved' then 'agreed' else 'closed' end where id=n.id returning * into n;
 return to_jsonb(n);
end $$;

do $$ declare r record; begin
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'wb\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);
 execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
