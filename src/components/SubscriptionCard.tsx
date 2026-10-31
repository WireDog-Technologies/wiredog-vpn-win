import React, { useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useVPN } from '@/context/VPNContext';
import { openPricingPage } from '@/lib/api';
import { shouldOfferSubscription, trialNote } from '@/lib/account';
import Logo from '../assets/logos/wiredog-minimal-navy_1024x1024.png';

/**
 * Shown to a signed-in personal account with no active plan. Opens the website's pricing page already
 * signed in. Hidden for everyone else, including every organization account.
 */
const SubscriptionCard: React.FC = () => {
  const { user, isSubscriptionActive } = useVPN();
  const [opening, setOpening] = useState(false);

  if (!shouldOfferSubscription(user, isSubscriptionActive)) return null;
  const note = trialNote(user);

  const handleClick = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openPricingPage();
    } finally {
      setOpening(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={opening}
      className="w-full flex items-center gap-3 rounded-xl border border-border/60 bg-card/90 backdrop-blur-xl px-4 py-3 text-left transition-colors hover:bg-card hover:border-accent/50 disabled:opacity-70"
    >
      <span className="w-10 h-10 flex items-center justify-center flex-shrink-0">
        <img src={Logo} alt="" className="w-10 h-10 object-contain" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block font-semibold text-sm leading-tight">Get a WireDog subscription</span>
        <span className="block text-xs text-accent leading-tight mt-0.5">Choose your plan</span>
        {note && (
          <span className={`block text-xs leading-tight mt-1 ${note.eligible ? 'text-connection-active' : 'text-muted-foreground'}`}>
            {note.text}
          </span>
        )}
      </span>
      {opening
        ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground flex-shrink-0" />
        : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
    </button>
  );
};

export default SubscriptionCard;
