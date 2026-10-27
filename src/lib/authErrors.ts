import type { ApiError } from '@/lib/api';

function asApiError(error: unknown): Partial<ApiError> {
  return (error && typeof error === 'object' ? error : {}) as Partial<ApiError>;
}

/** A sign-in attempt that is no longer valid because its 2FA challenge timed out. */
export function isChallengeExpired(error: unknown): boolean {
  return asApiError(error).code === 'two_factor_challenge_expired';
}

/** Message for a failed password / account-number login. */
export function describeLoginError(error: unknown, fallbackInvalid: string): string {
  const e = asApiError(error);
  if (e.status === 401 || e.status === 400) return fallbackInvalid;
  if (e.status === 403 && e.message) return e.message;
  if (e.status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (typeof e.status === 'number') return e.message || 'Sign-in failed. Please try again.';
  // fetch() rejects with a TypeError when the network is unreachable.
  return 'Could not reach WireDog. Check your connection and try again.';
}

/** Message for a failed 2FA code entry. */
export function describeTwoFactorError(error: unknown): string {
  const e = asApiError(error);
  if (isChallengeExpired(error)) return 'Your sign-in timed out. Please enter your password again.';
  if (e.status === 401) return "That code didn't work. Check your authenticator app and try again, or use a recovery code.";
  if (e.status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (typeof e.status === 'number') return e.message || 'Verification failed. Please try again.';
  return 'Could not reach WireDog. Check your connection and try again.';
}

/** Message for a failed SSO sign-in (errors thrown by electronAPI.sso or the code exchange). */
export function describeSsoError(error: unknown): string {
  const e = asApiError(error);
  const message = error instanceof Error ? error.message : '';
  if (message.includes('SSO_CANCELLED')) return 'Single sign-on was cancelled.';
  if (message.includes('SSO_NO_ACCOUNT')) return "Your organization hasn't given this email access. Contact your administrator.";
  if (message.includes('SSO_NOT_AVAILABLE')) return 'No single sign-on is set up for this email. Sign in with your password instead.';
  if (typeof e.status === 'number' && e.status !== 401) return e.message || 'Single sign-on didn\'t complete. Please try again.';
  if (!message && typeof e.status !== 'number') return 'Could not reach WireDog. Check your connection and try again.';
  return "Single sign-on didn't complete. Please try again.";
}

/** Message for a failed password change / reset. */
export function describePasswordError(error: unknown): string {
  const e = asApiError(error);
  if (e.status === 400) return e.message || "Couldn't change your password. Check the details and try again.";
  if (typeof e.status === 'number') return e.message || 'Something went wrong. Please try again.';
  return 'Could not reach WireDog. Check your connection and try again.';
}

export const PASSWORD_RULE = 'At least 8 characters with a letter and a number.';

export function passwordMeetsRules(password: string): boolean {
  return password.length >= 8 && password.length <= 128 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}

export function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}
