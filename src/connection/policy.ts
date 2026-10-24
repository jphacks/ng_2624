import type { FEOperation, ProfilePatch } from '../../Sample_db/fe-be.ts';
import type { AIUserProfile, UserRole } from '../../Sample_db/types.ts';
import { FE_REQUEST_DEFINITIONS } from './requests.ts';

const DAY = 24 * 60 * 60 * 1000;
/** BEで強制する認証ポリシー。Google認証・永続化・HTTPハンドラー自体はBEが組み込む。 */
export const AUTH_POLICY = {
  sessionCookie: '__Host-rb_session',
  pairingCookie: '__Host-rb_pairing',
  oauthCookie: '__Host-rb_oauth',
  csrfHeader: 'X-CSRF-Token',
  cookie: { secure: true, httpOnly: true, sameSite: 'Lax', path: '/', domain: null },
  parent: { idleMs: DAY, absoluteMs: 7 * DAY, maxDevices: null },
  child: { idleMs: 7 * DAY, absoluteMs: 30 * DAY, maxDevices: 1 },
  invitation: { lifetimeMs: 5 * 60 * 1000, singleUse: true, invalidatePreviousOnReissue: true },
  replaceChildSession: 'after_parent_approval',
  automaticRetry: false,
} as const;

export interface SessionTiming {
  role: UserRole;
  createdAt: string;
  lastActiveAt: string;
  revokedAt: string | null;
}
export type SessionStatus = 'active' | 'revoked' | 'idle_expired' | 'absolute_expired' | 'invalid';
export function sessionStatus(session: SessionTiming, now: string): SessionStatus {
  const current = Date.parse(now), created = Date.parse(session.createdAt), active = Date.parse(session.lastActiveAt);
  if (!['parent', 'child'].includes(session.role) || ![current, created, active].every(Number.isFinite)
    || created > active || active > current) return 'invalid';
  if (session.revokedAt !== null) return Number.isFinite(Date.parse(session.revokedAt)) ? 'revoked' : 'invalid';
  const policy = AUTH_POLICY[session.role];
  if (current - created >= policy.absoluteMs) return 'absolute_expired';
  if (current - active >= policy.idleMs) return 'idle_expired';
  return 'active';
}

/** 許可されたroleかの確認のみ。家族関係・所有権・提案版は必ずBEで照合する。 */
export function roleMayCall(operation: FEOperation, role: UserRole): boolean {
  if (!Object.hasOwn(FE_REQUEST_DEFINITIONS, operation)) return false;
  return FE_REQUEST_DEFINITIONS[operation].authentication === 'session'
    && FE_REQUEST_DEFINITIONS[operation].roles.includes(role);
}

/** 検証済みの差分を適用する。省略した兄弟項目を消さず、入力を変更しない。 */
export function applyProfilePatch(current: AIUserProfile, patch: ProfilePatch): AIUserProfile {
  return { ...structuredClone(current), ...structuredClone(patch),
    preferences: { ...structuredClone(current.preferences), ...structuredClone(patch.preferences ?? {}) } };
}
