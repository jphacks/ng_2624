-- Google認証済みユーザーを親として登録する

create or replace function public.register_google_parent()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_display_name text;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'ログインが必要です';
  end if;

  -- Google認証が紐づいているか確認
  if not exists (
    select 1
    from auth.identities i
    where i.user_id = v_user_id
      and i.provider = 'google'
  ) then
    raise exception 'Google認証が必要です';
  end if;

  -- Googleプロフィールの表示名を取得
  select coalesce(
    nullif(
      left(trim(u.raw_user_meta_data ->> 'full_name'), 100),
      ''
    ),
    'ユーザー'
  )
  into v_display_name
  from auth.users u
  where u.id = v_user_id;

  -- 既存ユーザーのroleは変更しない
  insert into public.users (
    id,
    display_name,
    role
  )
  values (
    v_user_id,
    v_display_name,
    'parent'
  )
  on conflict (id) do nothing;

  -- 最終的な役割を確認
  if not exists (
    select 1
    from public.users
    where id = v_user_id
      and role = 'parent'
  ) then
    raise exception '親ユーザーとして登録できません';
  end if;
end;
$$;

revoke all on function public.register_google_parent()
  from public, anon;

grant execute on function public.register_google_parent()
  to authenticated;