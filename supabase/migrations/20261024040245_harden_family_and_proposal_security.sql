-- WishBridge security hardening
-- Ensure that the child belongs to the negotiation's family
-- before accepting any proposal review.

create or replace function public.assert_proposal_child_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_family_id uuid;
  v_child_id uuid;
begin
  select n.family_id, n.child_id
  into v_family_id, v_child_id
  from public.proposals p
  join public.negotiations n on n.id = p.negotiation_id
  where p.id = new.proposal_id;

  if not found then
    raise exception '提案または交渉が見つかりません';
  end if;

  if not exists (
    select 1
    from public.family_members fm
    join public.users u on u.id = fm.user_id
    where fm.family_id = v_family_id
      and fm.user_id = v_child_id
      and fm.family_role = 'child'
      and u.role = 'child'
  ) then
    raise exception '交渉対象の子どもが家族に所属していません';
  end if;

  return new;
end;
$$;

revoke all on function public.assert_proposal_child_membership()
  from public, anon, authenticated;

create trigger check_proposal_child_membership
before insert on public.proposal_approvals
for each row
execute function public.assert_proposal_child_membership();
