import React, { useState } from 'react';
import { User, LogOut, Hash, ChevronLeft, FileText, HistoryIcon, Bug, HelpCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useVPN } from '@/context/VPNContext';
import InfoDialog from '@/components/InfoDialog';

const FRONTEND_URL = import.meta.env.VITE_FRONTEND_URL || 'https://wiredogvpn.com';

const formatBillingPeriod = (period: string): string => {
  return period
    .replace(/(\d+)\s*([a-zA-Z]+)/, (_, num, word) => `${num} ${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`);
};

const Account: React.FC = () => {
  const navigate = useNavigate();
  const { user, connection, logout } = useVPN();
  const [showDisconnectRequired, setShowDisconnectRequired] = useState(false);

  const handleLogout = async () => {
    if (connection.status !== 'disconnected') {
      setShowDisconnectRequired(true);
      return;
    }
    await logout();
    navigate('/');
  };

  if (!user) {
    return (
      <div className="h-full p-6 flex items-center justify-center">
        <Card className="p-8 text-center max-w-md">
          <User className="w-16 h-16 mx-auto mb-4 text-muted-foreground" />
          <h2 className="font-display text-2xl mb-2">Not Logged In</h2>
          <p className="text-muted-foreground mb-4">Please log in to view your account.</p>
          <Button variant="patriot" onClick={() => navigate('/')}>
            Go to Login
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-full p-6 star-pattern overflow-auto">
      {/* Back Button */}
      <button
        onClick={() => navigate(-1)}
        className="text-muted-foreground hover:text-foreground transition-colors mb-4 p-0"
      >
        <ChevronLeft className="w-8 h-8" />
      </button>

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="font-display text-4xl tracking-wider text-foreground mb-2">
            ACCOUNT
          </h1>
          <p className="text-muted-foreground">
            Manage your WireDog VPN account
          </p>
        </div>

        {/* Profile Card */}
        <Card className="p-6 mb-6 bg-sidebar">
          <div className="flex items-center gap-4 mb-6">
              <div className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center">
                {user.isAnonymous ? (
                  <Hash className="w-8 h-8 text-muted-foreground" />
                ) : (
                  <User className="w-8 h-8 text-muted-foreground" />
                )}
              </div>
              <div>
                <h2 className="text-xl font-semibold">
                  {user.isAnonymous ? 'Anonymous User' : user.username}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {user.isAnonymous ? `Account: ${user.accountNumber}` : 'Standard Account'}
                </p>
              </div>
          </div>

          <Separator className="my-4" />

          {/* Subscription Info */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg tracking-wide">SUBSCRIPTION</h3>
              {user.accountNumber && (
                <p className="text-sm text-muted-foreground font-mono">
                  Account Number: {user.accountNumber}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground mb-1">Plan</p>
                <p className="font-medium capitalize">
                  {user.subscriptionTier !== 'free' ? 'Active' : 'Inactive'}{user.billingPeriod ? ` - ${formatBillingPeriod(user.billingPeriod)}` : ''}
                </p>
              </div>

              <div className="p-4 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground mb-1">Time Remaining</p>
                <p className="font-medium">
                  {user.subscriptionExpiry
                    ? Math.ceil((user.subscriptionExpiry.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)) > 0
                      ? `${Math.ceil((user.subscriptionExpiry.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))} days left`
                      : 'Expired'
                    : '0 days left'}
                </p>
              </div>
            </div>

            {!user.isAnonymous && (
              <Button
                variant="outline"
                className="w-full mt-4"
                onClick={() => {
                  const url = `${FRONTEND_URL}/dashboard/account`;
                  if (window.electronAPI?.openExternal) {
                    window.electronAPI.openExternal(url);
                  } else {
                    window.open(url, '_blank');
                  }
                }}
              >
                Manage Subscription
              </Button>
            )}
          </div>
        </Card>

        {/* Support Card */}
        <Card className="p-6 mb-6">
          <h3 className="font-display text-lg tracking-wide mb-4">SUPPORT</h3>

          <div className="space-y-3">
            {/* Help Center */}
            <button
              onClick={() => {
                const helpUrl = `${FRONTEND_URL}/help`;
                if (window.electronAPI?.openExternal) {
                  window.electronAPI.openExternal(helpUrl);
                } else {
                  window.open(helpUrl, '_blank');
                }
              }}
              className="w-full flex items-center gap-3 p-4 -m-4 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                <HelpCircle className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="text-left flex-1">
                <p className="font-medium">Help Center</p>
                <p className="text-sm text-muted-foreground">Browse guides and frequently asked questions</p>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180 flex-shrink-0" />
            </button>

            <Separator />

            {/* Report an Issue */}
            <button
              onClick={() => navigate('/support/report-issue', { replace: true })}
              className="w-full flex items-center gap-3 p-4 -m-4 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                <Bug className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="text-left flex-1">
                <p className="font-medium">Report an Issue</p>
                <p className="text-sm text-muted-foreground">Tell us about problems you're experiencing</p>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180 flex-shrink-0" />
            </button>

            <Separator />

            {/* Debug Logs */}
            <button
              onClick={() => navigate('/support/debug-logs', { replace: true })}
              className="w-full flex items-center gap-3 p-4 -m-4 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                <FileText className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="text-left flex-1">
                <p className="font-medium">Debug Logs</p>
                <p className="text-sm text-muted-foreground">View and export diagnostic information</p>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180 flex-shrink-0" />
            </button>

            <Separator />

            {/* Changelog */}
            <button
              onClick={() => navigate('/support/changelog', { replace: true })}
              className="w-full flex items-center gap-3 p-4 -m-4 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                <HistoryIcon className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="text-left flex-1">
                <p className="font-medium">Changelog</p>
                <p className="text-sm text-muted-foreground">View version history and release notes</p>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180 flex-shrink-0" />
            </button>
          </div>
        </Card>

        {/* Logout Button */}
        <Button
          variant="outline"
          className="w-full border-accent/50 text-accent hover:bg-accent/10"
          onClick={handleLogout}
        >
          <LogOut className="w-4 h-4 mr-2" />
          Logout
        </Button>
      </div>

      {showDisconnectRequired && (
        <InfoDialog
          title="Disconnect Required"
          message="Please disconnect the VPN before signing out."
          onDismiss={() => setShowDisconnectRequired(false)}
        />
      )}
    </div>
  );
};

export default Account;
