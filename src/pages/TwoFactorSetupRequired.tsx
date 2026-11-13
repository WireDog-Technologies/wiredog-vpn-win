import React, { useState } from 'react';
import { Loader2, LogOut, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import { dashboardHandoffUrl } from '@/lib/api';
import TitleBar from '@/components/layout/TitleBar';

/**
 * Shown instead of the app when the user's organization requires two-factor authentication
 * (twoFactorRequiredByOrg) and they have not enrolled (totpEnabled == false). Enrollment happens
 * on the website, whose setup wizard shows the QR code and a manual key. The backend also refuses
 * /vpn/connect for these members, so this screen is the explanation, not the lock.
 *
 * Comes back on its own: the profile is re-read whenever the window regains focus, and the app
 * opens as soon as it says 2FA is on.
 */
const TwoFactorSetupRequired: React.FC = () => {
  const { user, refreshUser, logout } = useVPN();
  const [isOpening, setIsOpening] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  // The dashboard opens already signed in via a one-time handoff code, so the employee doesn't
  // have to sign in a second time. Falls back to the plain dashboard URL if no code can be minted.
  const openDashboard = async () => {
    setIsOpening(true);
    try {
      const url = await dashboardHandoffUrl();
      if (window.electronAPI?.openExternal) {
        await window.electronAPI.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    } finally {
      setIsOpening(false);
    }
  };

  const recheck = async () => {
    setIsChecking(true);
    try {
      await refreshUser();
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-background">
      <TitleBar />
    <div className="flex-1 flex items-center justify-center p-4 star-pattern relative overflow-hidden">
      <div className="absolute inset-0 tactical-grid opacity-20" />

      <div className="relative z-10 w-full max-w-md animate-fade-in-up">
        <Card className="p-8 border-border/50 backdrop-blur-sm text-center">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <ShieldAlert className="w-8 h-8 text-patriot-gold" />
          </div>
          <h1 className="font-display text-2xl tracking-wide mb-2">TWO-FACTOR AUTHENTICATION REQUIRED</h1>
          <p className="text-sm text-muted-foreground mb-6">
            {user?.organizationName ? `${user.organizationName} requires` : 'Your organization requires'} two-factor
            authentication. Set it up on your dashboard, then come back here to continue.
          </p>

          <div className="space-y-3">
            <Button variant="patriot" size="lg" className="w-full" onClick={openDashboard} disabled={isOpening}>
              {isOpening ? (<><Loader2 className="w-4 h-4 animate-spin" />Opening...</>) : 'Open Dashboard to Set Up'}
            </Button>
            <Button variant="outline" size="lg" className="w-full" onClick={recheck} disabled={isChecking}>
              {isChecking ? (<><Loader2 className="w-4 h-4 animate-spin" />Checking...</>) : "I've Set It Up"}
            </Button>
          </div>
        </Card>

        <div className="text-center mt-6">
          <button
            onClick={() => logout()}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </div>
    </div>
    </div>
  );
};

export default TwoFactorSetupRequired;
