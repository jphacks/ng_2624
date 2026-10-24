begin;
-- A saved thread is not an active consultation until its owner explicitly starts it.
alter table public.conversations add column started_at timestamptz;
alter table public.negotiations add column ai_lock_id uuid, add column ai_lock_expires_at timestamptz;
alter table public.negotiation_messages add column sequence_no bigint generated always as identity;
grant usage, select on sequence public.negotiation_messages_sequence_no_seq to service_role;
create index negotiation_messages_sequence_idx on public.negotiation_messages(negotiation_id,sequence_no);

create function public.wb_consultation_phase(p_actor_id uuid,p_conversation_id uuid) returns text language plpgsql set search_path='' as $$
declare c public.conversations; st text; begin
 select * into c from public.conversations where id=p_conversation_id and user_id=p_actor_id;
 if not found then raise exception 'Private conversation access denied' using errcode='42501'; end if;
 perform public.wb_family(p_actor_id,coalesce(c.child_id,p_actor_id));
 select n.status into st from public.proposals p join public.negotiations n on n.id=p.negotiation_id
 where p.conversation_id=c.id order by p.created_at desc,p.id desc limit 1;
 if st is null and c.context_proposal_id is not null then
 select n.status into st from public.proposals p join public.negotiations n on n.id=p.negotiation_id where p.id=c.context_proposal_id;
 end if;
 if st='awaiting_approval' then return 'awaiting_response'; end if;
 if st in ('revision_requested','gathering','proposing') then return 'negotiation'; end if;
 if st in ('agreed','closed') or c.context_proposal_id is not null then return 'closed'; end if;
 if c.started_at is null then return 'not_started'; end if;
 return 'consultation';
end $$;
create function public.wb_start_consultation(p_actor_id uuid,p_conversation_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare c public.conversations; phase text; begin
 select * into c from public.conversations where id=p_conversation_id and user_id=p_actor_id for update;
 phase:=public.wb_consultation_phase(p_actor_id,p_conversation_id);
 if phase not in ('not_started','consultation') then raise exception 'Consultation phase is not active'; end if;
 update public.conversations set started_at=coalesce(started_at,now()) where id=c.id returning * into c;
 return to_jsonb(c);
end $$;
-- Check both before generation and at commit, so navigation or a concurrent answer
-- cannot turn an obsolete operation into a valid phase transition.
alter function public.wb_begin_ai(uuid,uuid,uuid) rename to wb_begin_ai_v1;
create function public.wb_begin_ai(p_actor_id uuid,p_conversation_id uuid,p_lock_id uuid) returns jsonb language plpgsql set search_path='' as $$ begin
 perform 1 from public.conversations where id=p_conversation_id for update;
 if public.wb_consultation_phase(p_actor_id,p_conversation_id)<>'consultation' then raise exception 'Consultation phase is not active'; end if;
 return public.wb_begin_ai_v1(p_actor_id,p_conversation_id,p_lock_id);
end $$;
alter function public.wb_finish_ai(uuid,uuid,uuid,text,jsonb) rename to wb_finish_ai_v1;
create function public.wb_finish_ai(p_actor_id uuid,p_conversation_id uuid,p_lock_id uuid,p_message text,p_output jsonb) returns jsonb language plpgsql set search_path='' as $$ begin
 perform 1 from public.conversations where id=p_conversation_id for update;
 if public.wb_consultation_phase(p_actor_id,p_conversation_id)<>'consultation' then raise exception 'Consultation phase is not active'; end if;
 return public.wb_finish_ai_v1(p_actor_id,p_conversation_id,p_lock_id,p_message,p_output);
end $$;
alter function public.wb_select_product(uuid,uuid,uuid) rename to wb_select_product_v1;
create function public.wb_select_product(p_actor_id uuid,p_conversation_id uuid,p_product_id uuid) returns jsonb language plpgsql set search_path='' as $$ begin
 perform 1 from public.conversations where id=p_conversation_id for update;
 if public.wb_consultation_phase(p_actor_id,p_conversation_id)<>'consultation' then raise exception 'Consultation phase is not active'; end if;
 return public.wb_select_product_v1(p_actor_id,p_conversation_id,p_product_id);
end $$;

-- A negotiation row may reserve the proposal's approval context before No;
-- it becomes writable shared chat only at revision_requested.
create function public.wb_guard_negotiation_ai_lock() returns trigger language plpgsql set search_path='' as $$ begin
 if old.ai_lock_id is not null and old.ai_lock_expires_at>now()
 and coalesce(current_setting('wishbridge.negotiation_lock_id',true),'')<>old.ai_lock_id::text then raise exception 'Negotiation is busy'; end if;
 return new;
end $$;
create trigger wb_negotiation_ai_lock before update of status on public.negotiations for each row execute function public.wb_guard_negotiation_ai_lock();

alter function public.wb_send_proposal(uuid,uuid,integer,uuid) rename to wb_send_proposal_v1;
create function public.wb_send_proposal(p_actor_id uuid,p_proposal_id uuid,p_expected_version integer,p_parent_id uuid default null) returns jsonb language plpgsql set search_path='' as $$
declare p public.proposals; c public.conversations; n public.negotiations; result jsonb; candidate jsonb; begin
 select * into p from public.proposals where id=p_proposal_id for update;
 if p.based_on_proposal_id is null and p.status='draft' and public.wb_consultation_phase(p_actor_id,p.conversation_id)<>'consultation' then raise exception 'Consultation phase is not active'; end if;
 result:=public.wb_send_proposal_v1(p_actor_id,p_proposal_id,p_expected_version,p_parent_id);
 select * into p from public.proposals where id=p_proposal_id;
 select * into n from public.negotiations where id=p.negotiation_id for update;
 select * into c from public.conversations where id=p.conversation_id;
 select value into candidate from jsonb_array_elements(c.products) where value->>'id'=p.product_id::text;
 -- Only the explicitly sent product is copied; other private candidates stay private.
 if candidate is not null then
 update public.negotiations set products=case when exists(select 1 from jsonb_array_elements(products) x where x->>'id'=p.product_id::text) then products else products||jsonb_build_array(candidate) end,selected_product_id=p.product_id where id=n.id;
 end if;
 return result;
end $$;

create function public.wb_begin_negotiation_ai(p_actor_id uuid,p_negotiation_id uuid,p_lock_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare n public.negotiations; p public.proposals; begin
 select * into n from public.negotiations where id=p_negotiation_id for update;
 if n.id is null or n.parent_id is null or p_actor_id not in (n.child_id,n.parent_id) then raise exception 'Negotiation access denied' using errcode='42501'; end if;
 perform public.wb_family(p_actor_id,n.child_id);
 if n.status<>'revision_requested' then raise exception 'Negotiation phase is not active'; end if;
 if p_lock_id is null or (n.ai_lock_id is not null and n.ai_lock_expires_at>now()) then raise exception 'Negotiation is busy'; end if;
 select * into p from public.proposals where negotiation_id=n.id and status<>'draft' order by version desc limit 1;
 if p.status<>'rejected' then raise exception 'Negotiation phase is not active'; end if;
 update public.negotiations set ai_lock_id=p_lock_id,ai_lock_expires_at=now()+interval '150 seconds' where id=n.id returning * into n;
 return to_jsonb(n)||jsonb_build_object('basis_proposal_id',p.id,'basis_version',p.version);
end $$;
create function public.wb_cancel_negotiation_ai(p_actor_id uuid,p_negotiation_id uuid,p_lock_id uuid) returns boolean language plpgsql set search_path='' as $$ begin
 update public.negotiations set ai_lock_id=null,ai_lock_expires_at=null where id=p_negotiation_id and p_actor_id in (parent_id,child_id) and ai_lock_id=p_lock_id;
 return found;
end $$;
create function public.wb_select_negotiation_product(p_actor_id uuid,p_negotiation_id uuid,p_product_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare n public.negotiations; begin
 select * into n from public.negotiations where id=p_negotiation_id for update;
 if n.id is null or p_actor_id not in (n.child_id,n.parent_id) then raise exception 'Negotiation access denied' using errcode='42501'; end if;
 perform public.wb_family(p_actor_id,n.child_id);
 if n.status<>'revision_requested' then raise exception 'Negotiation phase is not active'; end if;
 if n.ai_lock_id is not null and n.ai_lock_expires_at>now() then raise exception 'Negotiation is busy'; end if;
 if not exists(select 1 from jsonb_array_elements(n.products) x where x->>'id'=p_product_id::text) then raise exception 'Product not in negotiation'; end if;
 update public.negotiations set selected_product_id=p_product_id where id=n.id returning * into n; return to_jsonb(n);
end $$;
create function public.wb_finish_negotiation_ai(p_actor_id uuid,p_negotiation_id uuid,p_lock_id uuid,p_basis_proposal_id uuid,p_basis_version integer,p_message text,p_output jsonb) returns jsonb language plpgsql set search_path='' as $$
declare n public.negotiations; p public.proposals; c public.conversations; draft public.proposals; d jsonb; x jsonb; result jsonb; draft_id uuid; draft_version integer; begin
 select * into n from public.negotiations where id=p_negotiation_id for update;
 if n.id is null or n.parent_id is null or p_actor_id not in (n.parent_id,n.child_id) then raise exception 'Negotiation access denied' using errcode='42501'; end if;
 perform public.wb_family(p_actor_id,n.child_id);
 if n.status<>'revision_requested' or n.ai_lock_id is distinct from p_lock_id or p_lock_id is null or n.ai_lock_expires_at<=now() then raise exception 'Negotiation phase or lease expired'; end if;
 select * into p from public.proposals where negotiation_id=n.id and status<>'draft' order by version desc limit 1;
 if p.id is distinct from p_basis_proposal_id or p.version is distinct from p_basis_version or p.status<>'rejected' then raise exception 'Stale proposal version'; end if;
 if p_output->>'action' is null or p_output->>'action' not in ('HEARING','PRODUCT','PROPOSAL','NEGOTIATION') or nullif(p_output->>'reply','') is null then raise exception 'Invalid AI output'; end if;
 if p_output->>'action'='PRODUCT' then
 if jsonb_typeof(p_output->'products') is distinct from 'array' then raise exception 'Products required'; end if;
 for x in select * from jsonb_array_elements(p_output->'products') loop
 insert into public.products(id,name,price_jpy,product_url,image_url,price_checked_at,size,description,recommendation_reason,source_urls)
 values((x->>'id')::uuid,x->>'name',(x->>'priceJpy')::integer,x->>'productUrl',x->>'imageUrl',(x->>'priceCheckedAt')::timestamptz,x->>'size',x->>'description',x->>'recommendationReason',array(select jsonb_array_elements_text(coalesce(x->'sourceUrls','[]'))));
 end loop;
 update public.negotiations set products=p_output->'products',selected_product_id=null where id=n.id returning * into n;
 end if;
 d:=nullif(p_output->'proposalDraft','null'::jsonb);
 if d is not null then
 if p_output->>'action' not in ('NEGOTIATION','PROPOSAL') or d->>'productId' is distinct from n.selected_product_id::text
 or d->'basedOn'->>'proposalId' is distinct from p.id::text or (d->'basedOn'->>'version')::integer is distinct from p.version then raise exception 'Draft must match shared selection and proposal version'; end if;
 -- Reuse the private draft/edit/send mechanism; no individual conversation text is copied.
 select * into c from public.conversations where user_id=p_actor_id and context_proposal_id=p.id order by created_at desc limit 1 for update;
 if c.id is null then
 insert into public.conversations(user_id,child_id,context_proposal_id,products,selected_product_id) values(p_actor_id,n.child_id,p.id,n.products,n.selected_product_id) returning * into c;
 else update public.conversations set products=n.products,selected_product_id=n.selected_product_id where id=c.id; end if;
 select * into draft from public.proposals where conversation_id=c.id and proposed_by=p_actor_id and status='draft' and based_on_proposal_id=p.id order by created_at desc limit 1;
 if draft.id is not null then draft_id:=draft.id; draft_version:=draft.version; end if;
 select value into x from jsonb_array_elements(n.products) where value->>'id'=d->>'productId';
 if x is null then raise exception 'Draft product not in negotiation'; end if;
 result:=public.wb_save_proposal(p_actor_id,c.id,(d->>'productId')::uuid,d->>'persuasionText',array(select jsonb_array_elements_text(coalesce(d->'purchaseConditions','[]'))),x->>'size',draft_id,draft_version,p.id);
 end if;
 if p_message is not null then insert into public.negotiation_messages(negotiation_id,sender,user_id,content) values(n.id,'user',p_actor_id,p_message); end if;
 insert into public.negotiation_messages(negotiation_id,sender,content) values(n.id,'assistant',p_output->>'reply');
 -- Private draft text is returned to its author, never through shared latest_ai_output.
 update public.negotiations set latest_ai_output=p_output-'proposalDraft',ai_lock_id=null,ai_lock_expires_at=null where id=n.id;
 return jsonb_build_object('draftProposalId',result->>'id');
end $$;

do $$ declare r record; begin
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'wb\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);
 execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
