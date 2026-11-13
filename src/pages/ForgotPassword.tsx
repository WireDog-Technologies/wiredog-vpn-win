import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, Key, Loader2, Mail, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import * as api from '@/lib/api';
import { describePasswordError, looksLikeEmail, passwordMeetsRules, PASSWORD_RULE } from '@/lib/authErrors';
import Logo from "../assets/logos/wiredog-minimal-navy_1024x1024.png";
import TitleBar from '@/components/layout/TitleBar';

type Step = 'email' | 'reset' | 'done';

/**
 * Password reset: email -> the code we emailed plus a new password. If the account has two-factor
 * authentication on, the reset also needs a current authenticator (or recovery) code.
 */
const ForgotPassword: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useVPN();

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState<string>((location.state as { email?: string } | null)?.email ?? '');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  // Learned when the reset code is verified; the reset then also carries a 2FA code.
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!looksLikeEmail(email)) {
      setError('Enter a valid email address.');
      return;
    }
    setIsLoading(true);
    try {
      await api.forgotPassword(email.trim());
      setInfo('If an account exists for that email, a reset code is on its way.');
      setStep('reset');
    } catch (err) {
      setError(describePasswordError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!resetCode.trim()) {
      setError('Enter the code from your email.');
      return;
    }
    if (!passwordMeetsRules(newPassword)) {
      setError(`New password: ${PASSWORD_RULE}`);
      return;
    }
    if (twoFactorRequired && !twoFactorCode.trim()) {
      setError('Enter a code from your authenticator app, or a recovery code.');
      return;
    }

    setIsLoading(true);
    try {
      const trimmedEmail = email.trim();
      // Checking the code first tells us whether this account also needs a 2FA code.
      const needs2fa = twoFactorRequired || await api.verifyResetCode(trimmedEmail, resetCode.trim());
      if (needs2fa && !twoFactorRequired) {
        setTwoFactorRequired(true);
        setInfo('Your account has two-factor authentication on. Enter a code from your authenticator app, or a recovery code, to finish.');
        return;
      }

      await api.resetPassword(trimmedEmail, resetCode.trim(), newPassword, needs2fa ? twoFactorCode.trim() : undefined);

      if (needs2fa) {
        // A 2FA account is NOT auto-signed-in: the reset already spent one 2FA code, and the login
        // challenge is a separate gate, so they go back to the login screen.
        setStep('done');
        return;
      }

      try {
        const outcome = await login(trimmedEmail, newPassword);
        if (outcome.status === 'signedIn') {
          navigate('/dashboard');
          return;
        }
      } catch {
        // Fall through to the "Password Updated" screen: the reset itself worked.
      }
      setStep('done');
    } catch (err) {
      setError(describePasswordError(err));
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
        <button
          onClick={() => navigate('/')}
          className="text-muted-foreground hover:text-foreground transition-colors mb-4 p-0"
          aria-label="Back to sign in"
        >
          <ChevronLeft className="w-8 h-8" />
        </button>

        <div className="text-center mb-6 flex flex-col items-center">
          <img src={Logo} alt="WireDog VPN Logo" className="w-20 h-20 object-contain mx-auto" />
          <h1 className="font-display text-3xl tracking-wider mt-2">RESET PASSWORD</h1>
        </div>

        <Card className="p-6 border-border/50 backdrop-blur-sm">
          {step === 'email' && (
            <form onSubmit={handleSendCode} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter the email on your account and we'll send you a code to reset your password.
              </p>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="email"
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                    className="pl-10"
                  />
                </div>
              </div>
              {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
              <Button type="submit" variant="patriot" size="lg" className="w-full" disabled={isLoading}>
                {isLoading ? (<><Loader2 className="w-4 h-4 animate-spin" />Sending...</>) : 'Send Reset Code'}
              </Button>
            </form>
          )}

          {step === 'reset' && (
            <form onSubmit={handleReset} className="space-y-4">
              {info && <p className="text-sm text-muted-foreground">{info}</p>}

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Reset Code</label>
                <Input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="Code from your email"
                  value={resetCode}
                  onChange={(e) => setResetCode(e.target.value.trim())}
                  disabled={twoFactorRequired}
                  autoFocus
                  className="font-mono tracking-wider"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">New Password</label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="password"
                    placeholder="Enter a new password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={twoFactorRequired}
                    className="pl-10"
                  />
                </div>
                <p className="text-xs text-muted-foreground">{PASSWORD_RULE}</p>
              </div>

              {twoFactorRequired && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4" />
                    Two-Factor Code
                  </label>
                  <Input
                    type="text"
                    autoComplete="one-time-code"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="Authenticator or recovery code"
                    value={twoFactorCode}
                    onChange={(e) => setTwoFactorCode(e.target.value.slice(0, 32))}
                    autoFocus
                    className="font-mono tracking-wider"
                  />
                </div>
              )}

              {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

              <Button type="submit" variant="patriot" size="lg" className="w-full" disabled={isLoading}>
                {isLoading ? (<><Loader2 className="w-4 h-4 animate-spin" />Working...</>) : (twoFactorRequired ? 'Reset Password' : 'Continue')}
              </Button>
              <button
                type="button"
                onClick={() => { setStep('email'); setError(null); setInfo(null); setTwoFactorRequired(false); setTwoFactorCode(''); }}
                disabled={isLoading}
                className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Use a different email
              </button>
            </form>
          )}

          {step === 'done' && (
            <div className="space-y-4 text-center">
              <h2 className="font-display text-xl tracking-wide">PASSWORD UPDATED</h2>
              <p className="text-sm text-muted-foreground">Your password was changed. Sign in with your new password.</p>
              <Button variant="patriot" size="lg" className="w-full" onClick={() => navigate('/')}>
                Back to Sign In
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
    </div>
  );
};

export default ForgotPassword;
