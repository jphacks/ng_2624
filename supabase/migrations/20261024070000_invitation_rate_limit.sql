-- 招待コード引き換えの試行回数制限

CREATE TABLE public.invitation_attempt_limits (
  child_id uuid PRIMARY KEY
    REFERENCES public.users(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0)
);

ALTER TABLE public.invitation_attempt_limits
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.invitation_attempt_limits
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.redeem_family_invitation(
  p_code_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_child_id uuid := auth.uid();
  v_invitation public.invitations%rowtype;
  v_request_id uuid;
  v_attempt_count integer;
BEGIN
  IF v_child_id IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = v_child_id
      AND role = 'child'
  ) THEN
    RAISE EXCEPTION '子どもユーザーのみ参加申請できます';
  END IF;

  -- 同じ子どもからの同時試行を直列化
  PERFORM 1
  FROM public.users
  WHERE id = v_child_id
  FOR UPDATE;

  -- 15分経過したらカウンターをリセット
  INSERT INTO public.invitation_attempt_limits (
    child_id,
    window_started_at,
    attempt_count
  )
  VALUES (
    v_child_id,
    clock_timestamp(),
    1
  )
  ON CONFLICT (child_id)
  DO UPDATE SET
    window_started_at =
      CASE
        WHEN invitation_attempt_limits.window_started_at
             <= clock_timestamp() - interval '15 minutes'
        THEN clock_timestamp()
        ELSE invitation_attempt_limits.window_started_at
      END,
    attempt_count =
      CASE
        WHEN invitation_attempt_limits.window_started_at
             <= clock_timestamp() - interval '15 minutes'
        THEN 1
        ELSE invitation_attempt_limits.attempt_count + 1
      END
  RETURNING attempt_count INTO v_attempt_count;

  -- 6回目以降はコード照合しない
  IF v_attempt_count > 5 THEN
    RETURN NULL;
  END IF;

  IF p_code_hash IS NULL
     OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT *
  INTO v_invitation
  FROM public.invitations
  WHERE code_hash = p_code_hash
  FOR UPDATE;

  IF NOT FOUND
     OR v_invitation.revoked_at IS NOT NULL
     OR v_invitation.expires_at <= now()
     OR v_invitation.redeemed_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.family_members
    WHERE family_id = v_invitation.family_id
      AND user_id = v_child_id
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.family_join_requests (
    family_id,
    invitation_id,
    child_id
  )
  VALUES (
    v_invitation.family_id,
    v_invitation.id,
    v_child_id
  )
  RETURNING id INTO v_request_id;

  UPDATE public.invitations
  SET redeemed_by = v_child_id,
      redeemed_at = now()
  WHERE id = v_invitation.id;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_family_invitation(text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.redeem_family_invitation(text)
  TO authenticated;
