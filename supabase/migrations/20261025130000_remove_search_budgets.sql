-- 予算による商品検索・提案の制限を廃止する。商品価格・目標額・ポイントは維持。
alter table public.child_settings drop column if exists reward_guidelines;
alter table public.user_preferences
  drop column if exists budget_small,
  drop column if exists budget_medium,
  drop column if exists budget_large;
