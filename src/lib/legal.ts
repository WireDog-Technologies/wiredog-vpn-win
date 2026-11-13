import type { LegalVersions } from '@/types/vpn';

export type LegalDocument = 'privacy' | 'terms';

const FRONTEND_URL: string = import.meta.env.VITE_FRONTEND_URL || 'https://wiredogvpn.com';

// Where the full documents live. Override per environment with VITE_PRIVACY_URL / VITE_TERMS_URL.
export const PRIVACY_URL: string = import.meta.env.VITE_PRIVACY_URL || `${FRONTEND_URL}/legal/privacy`;
export const TERMS_URL: string = import.meta.env.VITE_TERMS_URL || `${FRONTEND_URL}/legal/terms`;

// Accepted versions are stored on this device only (electron-store). Nothing about acceptance is
// sent to the server.
export const ACCEPTED_PRIVACY_KEY = 'acceptedPrivacyVersion';
export const ACCEPTED_TERMS_KEY = 'acceptedTermsVersion';

/**
 * Which legal documents the user still needs to accept. With no published versions (the backend
 * has none configured, predates the field, or can't be reached) nothing is ever pending: a
 * returning user is never blocked by a config problem.
 */
export function pendingLegal(
  legal: LegalVersions | null,
  acceptedPrivacy: string,
  acceptedTerms: string
): Set<LegalDocument> {
  const pending = new Set<LegalDocument>();
  if (!legal) return pending;
  if (acceptedPrivacy !== legal.privacyVersion) pending.add('privacy');
  if (acceptedTerms !== legal.termsVersion) pending.add('terms');
  return pending;
}

/** True when the user has accepted something before, i.e. the prompt is a re-accept of an update. */
export function isLegalUpdate(acceptedPrivacy: string, acceptedTerms: string): boolean {
  return acceptedPrivacy !== '' || acceptedTerms !== '';
}
