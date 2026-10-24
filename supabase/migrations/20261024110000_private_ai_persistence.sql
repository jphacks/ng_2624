begin;
alter table public.conversations add column context_proposal_id uuid references public.proposals(id), add column ai_lock_id uuid, add column ai_lock_expires_at timestamptz;
-- A pending AI operation owns its conversation's draft state until commit/cancel.
create function public.wb_guard_proposal_ai_lock() returns trigger language plpgsql set search_path='' as $$
declare c public.conversations; begin
 if new.conversation_id is null then return new; end if;
 select * into c from public.conversations where id=new.conversation_id for update;
 if c.ai_lock_id is not null and c.ai_lock_expires_at>now()
 and coalesce(current_setting('wishbridge.ai_lock_id',true),'')<>c.ai_lock_id::text then raise exception 'Conversation is busy'; end if;
 return new;
end $$;
create trigger wb_proposal_ai_lock before insert or update on public.proposals for each row execute function public.wb_guard_proposal_ai_lock();
create function public.wb_begin_ai(p_actor_id uuid,p_conversation_id uuid,p_lock_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare c public.conversations; begin
 select * into c from public.conversations where id=p_conversation_id and user_id=p_actor_id for update;
 if not found then raise exception 'Private conversation access denied'; end if;
 if p_lock_id is null then raise exception 'AI lock required'; end if;
 if c.ai_lock_id is not null and c.ai_lock_expires_at>now() then raise exception 'Conversation is busy'; end if;
 update public.conversations set ai_lock_id=p_lock_id,ai_lock_expires_at=now()+interval '150 seconds' where id=c.id returning * into c;
 return to_jsonb(c);
end $$;
create function public.wb_cancel_ai(p_actor_id uuid,p_conversation_id uuid,p_lock_id uuid) returns boolean language plpgsql set search_path='' as $$ begin
 update public.conversations set ai_lock_id=null,ai_lock_expires_at=null where id=p_conversation_id and user_id=p_actor_id and ai_lock_id=p_lock_id;
 return found;
end $$;
create function public.wb_select_product(p_actor_id uuid,p_conversation_id uuid,p_product_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare c public.conversations; begin
 select * into c from public.conversations where id=p_conversation_id and user_id=p_actor_id for update;
 if not found then raise exception 'Private conversation access denied'; end if;
 if c.ai_lock_id is not null and c.ai_lock_expires_at>now() then raise exception 'Conversation is busy'; end if;
 if not exists(select 1 from jsonb_array_elements(c.products) x where x->>'id'=p_product_id::text) then raise exception 'Product not in private conversation'; end if;
 update public.conversations set selected_product_id=p_product_id where id=c.id returning * into c; return to_jsonb(c);
end $$;
create function public.wb_finish_ai(p_actor_id uuid,p_conversation_id uuid,p_lock_id uuid,p_message text,p_output jsonb) returns jsonb language plpgsql set search_path='' as $$
declare c public.conversations; x jsonb; d jsonb; b public.proposals; selected jsonb; draft_id uuid; draft_version integer; based_id uuid; result jsonb; begin
 select * into c from public.conversations where id=p_conversation_id and user_id=p_actor_id for update;
 if not found then raise exception 'Private conversation access denied'; end if;
 if p_lock_id is null or c.ai_lock_id is distinct from p_lock_id or c.ai_lock_expires_at<=now() then raise exception 'AI lease expired or mismatched'; end if;
 if p_output is null or p_output->>'action' is null or p_output->>'action' not in ('HEARING','PRODUCT','PROPOSAL','NEGOTIATION') or nullif(p_output->>'reply','') is null then raise exception 'Invalid AI output'; end if;
 if p_output->>'action'='PRODUCT' then
 if jsonb_typeof(p_output->'products') is distinct from 'array' then raise exception 'Products required'; end if;
 for x in select * from jsonb_array_elements(p_output->'products') loop
 -- AI-generated UUIDs must be fresh; never modify another conversation's product.
 insert into public.products(id,name,price_jpy,product_url,image_url,price_checked_at,size,description,recommendation_reason,source_urls)
 values((x->>'id')::uuid,x->>'name',(x->>'priceJpy')::integer,x->>'productUrl',x->>'imageUrl',(x->>'priceCheckedAt')::timestamptz,x->>'size',x->>'description',x->>'recommendationReason',array(select jsonb_array_elements_text(coalesce(x->'sourceUrls','[]'))));
 end loop;
 update public.conversations set products=p_output->'products',selected_product_id=null where id=c.id returning * into c;
 end if;
 d:=nullif(p_output->'proposalDraft','null'::jsonb);
 if d is not null then
 if p_output->>'action' not in ('PROPOSAL','NEGOTIATION') then raise exception 'Unexpected proposal draft'; end if;
 select candidate.value into selected from jsonb_array_elements(c.products) as candidate(value) where candidate.value->>'id'=d->>'productId';
 if selected is null then raise exception 'Draft product not in conversation'; end if;
 if nullif(d->'basedOn','null'::jsonb) is not null then
 select * into b from public.proposals where id=(d->'basedOn'->>'proposalId')::uuid;
 if b.id is null or b.version is distinct from (d->'basedOn'->>'version')::integer then raise exception 'Stale proposal version'; end if;
 if b.status='draft' and b.proposed_by=p_actor_id and b.conversation_id=c.id then draft_id:=b.id; draft_version:=b.version;
 else based_id:=b.id; end if;
 end if;
 -- Reuse save validation inside this transaction; lease remains held until all writes succeed.
 perform set_config('wishbridge.ai_lock_id',p_lock_id::text,true);
 result:=public.wb_save_proposal(p_actor_id,c.id,(d->>'productId')::uuid,d->>'persuasionText',array(select jsonb_array_elements_text(coalesce(d->'purchaseConditions','[]'))),selected->>'size',draft_id,draft_version,based_id);
 end if;
 if p_message is not null then insert into public.messages(conversation_id,sender,content) values(c.id,'user',p_message); end if;
 insert into public.messages(conversation_id,sender,content,response_type,search_metadata) values(c.id,'assistant',p_output->>'reply',p_output->>'action',nullif(p_output->'search','null'::jsonb));
 update public.conversations set latest_ai_output=p_output,ai_lock_id=null,ai_lock_expires_at=null where id=c.id returning * into c;
 return to_jsonb(c);
end $$;

create or replace function public.wb_create_invitation(p_actor_id uuid,p_child_id uuid,p_token_hash text) returns jsonb language plpgsql set search_path='' as $$
declare f uuid; i public.app_invitations; begin
 perform 1 from public.users where id=p_child_id for update;
 f:=public.wb_family(p_actor_id,p_child_id);
 if p_actor_id=p_child_id then raise exception 'Parent required'; end if;
 update public.app_invitations set expires_at=now() where child_id=p_child_id and expires_at>now();
 insert into public.app_invitations(token_hash,child_id,parent_id,family_id,expires_at) values(p_token_hash,p_child_id,p_actor_id,f,now()+interval '5 minutes') returning * into i;
 return to_jsonb(i);
end $$;

create or replace function public.wb_complete_pairing(p_request_id uuid,p_token_hash text,p_session_token_hash text,p_csrf_token text) returns jsonb language plpgsql set search_path='' as $$
declare i public.app_invitations; r public.app_pairing_requests; s public.app_sessions; begin
 select * into r from public.app_pairing_requests where id=p_request_id and token_hash=p_token_hash for update;
 if not found or r.status<>'approved' or r.expires_at<=now() then raise exception 'Pairing unavailable'; end if;
 select * into i from public.app_invitations where id=r.invitation_id;
 perform 1 from public.users where id=i.child_id for update;
 select * into i from public.app_invitations where id=r.invitation_id;
 if i.expires_at<=now() or public.wb_family(i.parent_id,i.child_id)<>i.family_id then raise exception 'Invitation unavailable'; end if;
 update public.app_sessions set revoked_at=now() where user_id=i.child_id and revoked_at is null;
 insert into public.app_sessions(token_hash,user_id,csrf_token,expires_at,device_label) values(p_session_token_hash,i.child_id,p_csrf_token,now()+interval '30 days','子どもの端末') returning * into s;
 update public.app_pairing_requests set status='completed',completed_at=now() where id=r.id; return to_jsonb(s);
end $$;

do $$ declare r record; begin
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'wb\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);
 execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
