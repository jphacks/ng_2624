-- WishBridge: 商品購入ゴールを円単位に変更

-- 既存のポイント値を誤って円として引き継がないよう、
-- 既存ゴールがある場合は移行を停止する。
do $$
begin
  if exists (select 1 from public.goals) then
    raise exception
      '既存ゴールがあります。required_points の移行方針を決めてください';
  end if;
end;
$$;

-- 目標金額を円単位へ変更
alter table public.goals
  rename column required_points to target_amount_yen;

alter table public.goals
  drop constraint if exists goals_required_points_check;

alter table public.goals
  add constraint goals_target_amount_yen_check
  check (target_amount_yen >= 0);

comment on column public.goals.target_amount_yen is
  '親子合意時の商品価格全額。日本円、整数。';

-- 合意済み提案からゴールを作成する内部関数
create or replace function public.create_goal_on_agreement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_child_id uuid;
  v_product_id uuid;
  v_price_jpy integer;
  v_size text;
begin
  if new.status <> 'agreed'
     or old.status is not distinct from 'agreed' then
    return new;
  end if;

  select
    n.child_id,
    p.product_id,
    pr.price_jpy
  into
    v_child_id,
    v_product_id,
    v_price_jpy
  from public.negotiations n
  join public.products pr on pr.id = new.product_id
  join public.proposals p on p.id = new.id
  where n.id = new.negotiation_id;

  if v_child_id is null then
    raise exception '交渉に子どもが設定されていません';
  end if;

  if v_price_jpy is null then
    raise exception '商品価格が未設定のためゴールを作成できません';
  end if;

  -- sizeは既存スキーマの必須項目。
  -- 価格から仮の区分を決めるが、目標金額には影響しない。
  v_size := case
    when v_price_jpy < 3000 then 'small'
    when v_price_jpy < 10000 then 'medium'
    else 'large'
  end;

  insert into public.goals (
    child_id,
    proposal_id,
    product_id,
    size,
    target_amount_yen
  )
  values (
    v_child_id,
    new.id,
    v_product_id,
    v_size,
    v_price_jpy
  )
  on conflict (proposal_id) do nothing;

  return new;
end;
$$;

-- ブラウザから内部関数を直接実行させない
revoke all on function public.create_goal_on_agreement()
  from public, anon, authenticated;

drop trigger if exists create_goal_after_agreement
  on public.proposals;

create trigger create_goal_after_agreement
after update of status on public.proposals
for each row
execute function public.create_goal_on_agreement();
