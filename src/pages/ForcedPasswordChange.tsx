import React, { useState } from 'react';
import { KeyRound, Loader2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import { describePasswordError, passwordMeetsRules, PASSWORD_RULE } from '@/lib/authErrors';
import Logo from "../assets/logos/wiredog-minimal-navy_1024x1024.png";
import TitleBar from '@/components/layout/TitleBar';

/**
 * Shown instead of the app when /auth/me says mustChangePassword: an admin-provisioned employee
 * signed in with a temporary password and has to replace it. The backend clears the flag on a
 * successful change, and the refreshed profile then lets the app through.
 */
const ForcedPasswordChange: React.FC = () => {
  const { changePassword, logout, user } = useVPN();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!currentPassword) {
      setError('Enter your temporary password.');
      return;
    }
    if (!passwordMeetsRules(newPassword)) {
      setError(`New password: ${PASSWORD_RULE}`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The new passwords don't match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError('Choose a password different from the temporary one.');
      return;
    }

    setIsLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setError(
        status === 400
          ? "Couldn't change your password. Check your temporary password, and that the new one is at least 8 characters with a letter and a number."
          : describePasswordError(err)
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-background">
      <TitleBar />
    <div className="flex-1 flex items-center justify-center p-4 star-pattern relative overflow-hidden">
      <div className="absolute inset-0 tactical-grid opacity-20" />

      <div className="relative z-10 w-full max-w-md animate-fade-in-up">
        <div className="text-center mb-6 flex flex-col items-center">
          <img src={Logo} alt="WireDog VPN Logo" className="w-20 h-20 object-contain mx-auto" />
          <h1 className="font-display text-3xl tracking-wider mt-2">CHOOSE A NEW PASSWORD</h1>
          <p className="text-sm text-muted-foreground mt-2">
            {user?.organizationName
              ? `${user.organizationName} gave you a temporary password.`
              : 'You signed in with a temporary password.'}{' '}
            Replace it to continue.
          </p>
        </div>

        <Card className="p-6 border-border/50 backdrop-blur-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Temporary Password</label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Temporary password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoFocus
                  className="pl-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">New Password</label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="pl-10"
                />
              </div>
              <p className="text-xs text-muted-foreground">{PASSWORD_RULE}</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Confirm New Password</label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

            <Button type="submit" variant="patriot" size="lg" className="w-full" disabled={isLoading}>
              {isLoading ? (<><Loader2 className="w-4 h-4 animate-spin" />Saving...</>) : 'Change Password'}
            </Button>
          </form>
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

export default ForcedPasswordChange;
