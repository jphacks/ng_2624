-- ==================================================
-- WishBridge DB仕上げ
-- ==================================================

-- 1. AIリクエストをブラウザから直接操作できないようにする

alter table public.ai_requests
  enable row level security;

revoke all on public.ai_requests from anon, authenticated;


-- 2. 提案の承認・修正要求RPC
-- 親子双方が同じ提案バージョンを承認したら agreed にする

create or replace function public.review_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_comment text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_proposal public.proposals%rowtype;
  v_negotiation public.negotiations%rowtype;
  v_user_role text;
  v_parent_count integer;
  v_child_approved boolean;
begin
  if v_user_id is null then
    raise exception 'ログインが必要です';
  end if;

  if p_decision is null
     or p_decision not in (
       'approved', 'rejected', 'revision_requested'
     ) then
    raise exception '無効な判断です';
  end if;

  -- 交渉行をロックして、同時承認を直列化する
  select n.*
  into v_negotiation
  from public.negotiations n
  join public.proposals p on p.negotiation_id = n.id
  where p.id = p_proposal_id
  for update of n;

  if not found then
    raise exception '提案が見つかりません';
  end if;

  select *
  into v_proposal
  from public.proposals
  where id = p_proposal_id;

  if v_proposal.status <> 'pending' then
    raise exception '承認待ちの提案ではありません';
  end if;

  if v_negotiation.status <> 'awaiting_approval' then
    raise exception '現在承認できる交渉ではありません';
  end if;

  -- 最新バージョンの提案だけを対象にする
  if exists (
    select 1
    from public.proposals p
    where p.negotiation_id = v_proposal.negotiation_id
      and p.version > v_proposal.version
  ) then
    raise exception '古いバージョンの提案です';
  end if;

  -- 子ども本人、または同じ家族の親だけが操作できる
  if v_user_id = v_negotiation.child_id then
    v_user_role := 'child';

    if not exists (
      select 1 from public.users
      where id = v_user_id and role = 'child'
    ) then
      raise exception '子どもユーザーではありません';
    end if;

  elsif exists (
    select 1
    from public.family_members fm
    join public.users u on u.id = fm.user_id
    where fm.family_id = v_negotiation.family_id
      and fm.user_id = v_user_id
      and fm.family_role = 'parent'
      and u.role = 'parent'
  ) then
    v_user_role := 'parent';

  else
    raise exception 'この提案を確認する権限がありません';
  end if;

  -- 一人につき提案ごとに一度だけ判断できる
  if exists (
    select 1
    from public.proposal_approvals
    where proposal_id = p_proposal_id
      and user_id = v_user_id
  ) then
    raise exception 'この提案にはすでに回答しています';
  end if;

  insert into public.proposal_approvals (
    proposal_id,
    user_id,
    decision,
    comment
  )
  values (
    p_proposal_id,
    v_user_id,
    p_decision,
    p_comment
  );

  if p_decision = 'rejected' then
    update public.proposals
    set status = 'rejected'
    where id = p_proposal_id;

    update public.negotiations
    set status = 'revision_requested'
    where id = v_negotiation.id;

    return 'rejected';
  end if;

  if p_decision = 'revision_requested' then
    update public.negotiations
    set status = 'revision_requested'
    where id = v_negotiation.id;

    return 'revision_requested';
  end if;

  -- 子どもの承認を確認
  select exists (
    select 1
    from public.proposal_approvals pa
    where pa.proposal_id = p_proposal_id
      and pa.user_id = v_negotiation.child_id
      and pa.decision = 'approved'
  )
  into v_child_approved;

  -- 同じ家族に所属する親の承認を確認
  select count(*)
  into v_parent_count
  from public.proposal_approvals pa
  join public.family_members fm
    on fm.user_id = pa.user_id
   and fm.family_id = v_negotiation.family_id
  join public.users u
    on u.id = pa.user_id
  where pa.proposal_id = p_proposal_id
    and pa.decision = 'approved'
    and fm.family_role = 'parent'
    and u.role = 'parent';

  if v_child_approved and v_parent_count > 0 then
    update public.proposals
    set status = 'agreed'
    where id = p_proposal_id;

    update public.negotiations
    set status = 'agreed'
    where id = v_negotiation.id;

    return 'agreed';
  end if;

  return 'pending';
end;
$$;

revoke all on function public.review_proposal(
  uuid, text, text
) from public, anon;

grant execute on function public.review_proposal(
  uuid, text, text
) to authenticated;