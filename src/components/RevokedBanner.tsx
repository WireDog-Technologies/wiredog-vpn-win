import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { useVPN } from '@/context/VPNContext';
import { isRevokedWithoutAccess, REVOKED_ACCOUNT_MESSAGE } from '@/lib/account';

/**
 * Shown instead of the subscription card when staff revoked the account. Stays up across sign-out
 * and sign-in, because it follows the account's state, not a one-time event.
 */
const RevokedBanner: React.FC = () => {
  const { user, isSubscriptionActive } = useVPN();

  if (!isRevokedWithoutAccess(user, isSubscriptionActive)) return null;

  return (
    <div
      role="alert"
      className="w-full flex items-start gap-3 rounded-xl border border-destructive/50 bg-card/90 backdrop-blur-xl px-4 py-3"
    >
      <ShieldAlert className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
      <span className="flex-1 min-w-0">
        <span className="block font-semibold text-sm leading-tight">Account revoked</span>
        <span className="block text-xs text-muted-foreground leading-snug mt-1">{REVOKED_ACCOUNT_MESSAGE}</span>
      </span>
    </div>
  );
};

export default RevokedBanner;
