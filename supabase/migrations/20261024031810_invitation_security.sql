-- 招待コードのセキュリティ強化
-- 発行・引き換えのDB処理をまとめて実装

-- 1. 招待コードの状態管理
alter table public.invitations
  add column if not exists revoked_at timestamptz;

create index if not exists invitations_family_created_idx
  on public.invitations(family_id, created_at desc);

-- 2. 招待コードの発行
-- コードそのものはEdge Functionで暗号学的に安全な乱数から生成し、
-- SHA-256ハッシュだけをDBに渡す。
create or replace function public.create_family_invitation(
  p_family_id uuid,
  p_code_hash text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_id uuid := auth.uid();
  v_invitation_id uuid;
begin
  if v_parent_id is null then
    raise exception 'ログインが必要です';
  end if;

  if not exists (
    select 1
    from public.family_members fm
    join public.users u on u.id = fm.user_id
    where fm.family_id = p_family_id
      and fm.user_id = v_parent_id
      and fm.family_role = 'parent'
      and u.role = 'parent'
  ) then
    raise exception '招待コードを発行する権限がありません';
  end if;

  if p_code_hash is null
     or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'コードハッシュが不正です';
  end if;

  if p_expires_at is null
     or p_expires_at <= now()
     or p_expires_at > now() + interval '24 hours' then
    raise exception '有効期限が不正です';
  end if;

  insert into public.invitations (
    family_id, created_by, code_hash, expires_at
  )
  values (
    p_family_id, v_parent_id, p_code_hash, p_expires_at
  )
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$$;

revoke all on function public.create_family_invitation(
  uuid, text, timestamptz
) from public, anon;

-- 発行はEdge Function経由で行う。
-- service_roleはRLSをバイパスするため、
-- Edge Functionで本人のJWTを検証したうえで、
-- ユーザーJWTを使ってRPCを呼び出す設計とする。
grant execute on function public.create_family_invitation(
  uuid, text, timestamptz
) to authenticated;


-- 3. 招待コードの引き換え・参加申請
-- コードのSHA-256ハッシュを受け取り、原子的に使用済みにする。
create or replace function public.redeem_family_invitation(
  p_code_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_child_id uuid := auth.uid();
  v_invitation public.invitations%rowtype;
  v_request_id uuid;
begin
  if v_child_id is null then
    raise exception 'ログインが必要です';
  end if;

  if not exists (
    select 1 from public.users
    where id = v_child_id and role = 'child'
  ) then
    raise exception '子どもユーザーのみ参加申請できます';
  end if;

  if p_code_hash is null
     or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception '招待コードが不正です';
  end if;

  select *
  into v_invitation
  from public.invitations
  where code_hash = p_code_hash
  for update;

  if not found
     or v_invitation.revoked_at is not null
     or v_invitation.expires_at <= now()
     or v_invitation.redeemed_at is not null then
    raise exception '招待コードが無効または使用済みです';
  end if;

  if exists (
    select 1
    from public.family_members
    where family_id = v_invitation.family_id
      and user_id = v_child_id
  ) then
    raise exception 'すでに家族に所属しています';
  end if;

  insert into public.family_join_requests (
    family_id, invitation_id, child_id
  )
  values (
    v_invitation.family_id, v_invitation.id, v_child_id
  )
  returning id into v_request_id;

  update public.invitations
  set redeemed_by = v_child_id,
      redeemed_at = now()
  where id = v_invitation.id;

  return v_request_id;
end;
$$;

revoke all on function public.redeem_family_invitation(text)
  from public, anon;

grant execute on function public.redeem_family_invitation(text)
  to authenticated;


-- 4. 招待コードの取り消し
create or replace function public.revoke_family_invitation(
  p_invitation_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_id uuid := auth.uid();
begin
  if v_parent_id is null then
    raise exception 'ログインが必要です';
  end if;

  update public.invitations i
  set revoked_at = now()
  where i.id = p_invitation_id
    and i.revoked_at is null
    and exists (
      select 1
      from public.family_members fm
      join public.users u on u.id = fm.user_id
      where fm.family_id = i.family_id
        and fm.user_id = v_parent_id
        and fm.family_role = 'parent'
        and u.role = 'parent'
    );

  if not found then
    raise exception '招待コードが見つからないか、権限がありません';
  end if;
end;
$$;

revoke all on function public.revoke_family_invitation(uuid)
  from public, anon;

grant execute on function public.revoke_family_invitation(uuid)
  to authenticated;