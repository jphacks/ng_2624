-- WishBridge: ポイント制から円単位へ統一

-- お手伝いの報酬
ALTER TABLE public.tasks
  RENAME COLUMN reward_points TO reward_amount_yen;

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_reward_points_check;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_reward_amount_yen_check
  CHECK (reward_amount_yen >= 0);

COMMENT ON COLUMN public.tasks.reward_amount_yen IS
  'お手伝い完了時に獲得できる金額（円）';

-- 獲得金額の履歴
ALTER TABLE public.point_transactions
  RENAME COLUMN delta_points TO delta_amount_yen;

ALTER TABLE public.point_transactions
  DROP CONSTRAINT IF EXISTS point_transactions_delta_points_check;

ALTER TABLE public.point_transactions
  RENAME TO amount_transactions;

ALTER TABLE public.amount_transactions
  ADD CONSTRAINT amount_transactions_delta_amount_yen_check
  CHECK (delta_amount_yen <> 0);

ALTER INDEX IF EXISTS public.point_transactions_child_idx
  RENAME TO amount_transactions_child_idx;

COMMENT ON COLUMN public.amount_transactions.delta_amount_yen IS
  '獲得・調整した金額の増減（円）';

COMMENT ON TABLE public.amount_transactions IS
  '子どもの獲得金額の取引履歴';
