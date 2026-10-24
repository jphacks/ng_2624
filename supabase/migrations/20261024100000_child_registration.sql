begin;
-- Auth account creation happens in the BE; this transaction creates its app profile + family membership.
create function public.wb_create_child(p_actor_id uuid,p_child_id uuid,p_display_name text,p_birth_date date,p_gender text,p_grade_level integer,p_grade_base_school_year integer)
returns jsonb language plpgsql set search_path='' as $$
declare f uuid; u public.users; begin
 perform 1 from public.users where id=p_actor_id and role='parent' for update;
 if not found then raise exception 'Parent required'; end if;
 select family_id into f from public.family_members where user_id=p_actor_id and family_role='parent' order by joined_at limit 1;
 if f is null then raise exception 'Parent family required'; end if;
 if p_child_id=p_actor_id or length(trim(coalesce(p_display_name,''))) not between 1 and 100 or p_birth_date is null or p_birth_date>current_date then raise exception 'Invalid child profile'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_child_id::text,0));
 select * into u from public.users where id=p_child_id;
 if found then
  if u.role<>'child' or not exists(select 1 from public.family_members where user_id=p_child_id and family_id=f and family_role='child') then raise exception 'Child account already belongs elsewhere'; end if;
  return jsonb_build_object('user',to_jsonb(u),'family_id',f);
 end if;
 insert into public.users(id,display_name,role,birth_date,gender,grade_level,grade_base_school_year)
 values(p_child_id,p_display_name,'child',p_birth_date,p_gender,p_grade_level,p_grade_base_school_year) returning * into u;
 insert into public.family_members(family_id,user_id,family_role) values(f,p_child_id,'child');
 insert into public.child_settings(child_id,parent_id) values(p_child_id,p_actor_id);
 return jsonb_build_object('user',to_jsonb(u),'family_id',f);
end $$;
revoke all on function public.wb_create_child(uuid,uuid,text,date,text,integer,integer) from public,anon,authenticated;
grant execute on function public.wb_create_child(uuid,uuid,text,date,text,integer,integer) to service_role;
commit;
