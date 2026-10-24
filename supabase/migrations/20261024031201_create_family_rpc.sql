-- 親が家族ルームを作成するRPC

create or replace function public.create_family(
  p_family_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_family_id uuid;
begin
  -- 呼び出し元の認証ユーザー
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'ログインが必要です';
  end if;

  -- 親ユーザーであることを確認
  if not exists (
    select 1
    from public.users
    where id = v_user_id
      and role = 'parent'
  ) then
    raise exception '親ユーザーのみ家族を作成できます';
  end if;

  -- 家族名の入力チェック
  if p_family_name is null
     or length(trim(p_family_name)) = 0
     or length(p_family_name) > 100 then
    raise exception '家族名が不正です';
  end if;

  -- 家族ルームを作成
  insert into public.families (
    name,
    created_by
  )
  values (
    trim(p_family_name),
    v_user_id
  )
  returning id into v_family_id;

  -- 作成者を親として登録
  insert into public.family_members (
    family_id,
    user_id,
    family_role
  )
  values (
    v_family_id,
    v_user_id,
    'parent'
  );

  return v_family_id;
end;
$$;

-- ログイン済みユーザーのみ実行可能
revoke all on function public.create_family(text) from public;
revoke all on function public.create_family(text) from anon;
grant execute on function public.create_family(text) to authenticated;