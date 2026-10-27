import type { OrganizationAccess, User } from '@/types/vpn';

/**
 * Whether the backend will let this account connect. An org seat's expiry can be absent (the org's
 * Stripe period isn't always mirrored), so for those trust `isActive`, which /auth/me derives from
 * the org's live subscription. Personal accounts keep the tier/expiry check.
 */
export function hasEntitlement(user: User | null): boolean {
  if (!user) return false;
  if (user.subscriptionManagedByOrganization) return user.isActive;
  if (user.subscriptionTier === 'free') return false;
  if (user.subscriptionExpiry && user.subscriptionExpiry < new Date()) return false;
  return true;
}

/**
 * An 'inactive' org (lapsed subscription) still owns the seat, so the account stays org-managed.
 * 'revoked' does not: that person is a plain consumer again.
 */
export function isOrganizationMember(user: User | null): boolean {
  if (!user) return false;
  return !!user.organizationName || user.subscriptionManagedByOrganization || user.organizationAccess === 'inactive';
}

/**
 * Set only when an organization used to cover this account and no longer does. The app shows this
 * instead of treating the account as a plain unpaid one.
 */
export function lostOrganizationAccess(user: User | null): Exclude<OrganizationAccess, 'active'> | null {
  const access = user?.organizationAccess;
  return access === 'inactive' || access === 'revoked' ? access : null;
}

export function organizationAccessMessage(access: Exclude<OrganizationAccess, 'active'>): string {
  return access === 'inactive'
    ? "Your organization's WireDog subscription isn't active right now. Contact your administrator."
    : 'Your organization has removed your access to WireDog VPN. Contact your administrator if you think this is a mistake.';
}

/** Blocked before the app opens: replace the temporary password first, then set up org-required 2FA. */
export type AccountGate = 'password-change' | 'two-factor-setup' | null;

export function accountGate(user: User | null): AccountGate {
  if (!user) return null;
  if (user.mustChangePassword) return 'password-change';
  if (user.twoFactorRequiredByOrg && !user.totpEnabled) return 'two-factor-setup';
  return null;
}
