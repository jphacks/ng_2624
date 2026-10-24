-- 家族への参加申請を親が承認・拒否するRPC

create or replace function public.review_family_join(
  p_request_id uuid,
  p_decision text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_id uuid;
  v_request public.family_join_requests%rowtype;
begin
  v_parent_id := auth.uid();

  if v_parent_id is null then
    raise exception 'ログインが必要です';
  end if;

  if p_decision is null
     or p_decision not in ('approved', 'rejected') then
    raise exception '承認または拒否を指定してください';
  end if;

  -- 申請行をロックして二重承認を防ぐ
  select *
    into v_request
  from public.family_join_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception '参加申請が見つかりません';
  end if;

  -- 対象家族の親であることを確認
  if not exists (
    select 1
    from public.family_members fm
    join public.users u on u.id = fm.user_id
    where fm.family_id = v_request.family_id
      and fm.user_id = v_parent_id
      and fm.family_role = 'parent'
      and u.role = 'parent'
  ) then
    raise exception 'この申請を処理する権限がありません';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'この申請はすでに処理されています';
  end if;

  -- 申請者が子どもであることを確認
  if not exists (
    select 1
    from public.users
    where id = v_request.child_id
      and role = 'child'
  ) then
    raise exception '子どもユーザーが見つかりません';
  end if;

  -- 招待状が対象家族に属していることを確認
  if not exists (
    select 1
    from public.invitations i
    where i.id = v_request.invitation_id
      and i.family_id = v_request.family_id
      and i.redeemed_by = v_request.child_id
      and i.redeemed_at is not null
  ) then
    raise exception '招待情報が不正です';
  end if;

  if p_decision = 'approved' then
    -- 同じ家族への登録が既にある場合はエラーにする
    if exists (
      select 1
      from public.family_members
      where family_id = v_request.family_id
        and user_id = v_request.child_id
    ) then
      raise exception 'すでに家族に所属しています';
    end if;

    insert into public.family_members (
      family_id,
      user_id,
      family_role
    )
    values (
      v_request.family_id,
      v_request.child_id,
      'child'
    );
  end if;

  update public.family_join_requests
  set status = p_decision,
      reviewed_by = v_parent_id,
      reviewed_at = now()
  where id = p_request_id;

  return p_decision;
end;
$$;

revoke all on function public.review_family_join(uuid, text)
  from public, anon;

grant execute on function public.review_family_join(uuid, text)
  to authenticated;