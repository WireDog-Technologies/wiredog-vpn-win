import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Key, Hash, Loader2, AlertTriangle, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useVPN } from '@/context/VPNContext';
import TitleBar from '@/components/layout/TitleBar';
import TwoFactorCodeForm from '@/components/TwoFactorCodeForm';
import { ssoAvailable } from '@/lib/api';
import {
  describeLoginError,
  describeSsoError,
  describeTwoFactorError,
  isChallengeExpired,
  looksLikeEmail,
} from '@/lib/authErrors';
import Logo from "../assets/logos/wiredog-minimal-navy_1024x1024.png";
import TextLogo from "../assets/logos/wiredog_text_logo_1024.png";

const Login: React.FC = () => {
  const navigate = useNavigate();
  const { login, anonymousLogin, verifyTwoFactor, signInWithSso, cancelSso } = useVPN();

  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [resetting, setResetting] = useState(false);
  // 'login': the tabs. 'sso': the work-email step. 'twoFactor': the code step after a login that
  // asked for 2FA (the challenge token is held in memory only and dropped if the user backs out).
  const [view, setView] = useState<'login' | 'sso' | 'twoFactor'>('login');
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<string | null>(null);
  const [ssoWaiting, setSsoWaiting] = useState(false);
  // Shown in red under the form for whichever view is up.
  const [formError, setFormError] = useState<string | null>(null);

  const formatAccountNumber = (value: string): string => {
    const cleaned = value.replace(/\D/g, '');
    const chunks = cleaned.match(/.{1,4}/g) || [];
    return chunks.join('-');
  };

  // A signed-in outcome needs nothing here: isAuthenticated flips and the router swaps this screen
  // out. Only the 2FA challenge needs UI.
  const handleOutcome = (outcome: Awaited<ReturnType<typeof login>>) => {
    if (outcome.status === 'twoFactorRequired') {
      setTwoFactorChallenge(outcome.challengeToken);
      setView('twoFactor');
      return;
    }
    navigate('/dashboard');
  };

  const runSso = async () => {
    setFormError(null);
    setSsoWaiting(true);
    try {
      await signInWithSso(email);
      navigate('/dashboard');
    } catch (error) {
      setFormError(describeSsoError(error));
    } finally {
      setSsoWaiting(false);
    }
  };

  const handleStandardLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!email || !password) {
      setFormError('Please fill in all fields.');
      return;
    }

    setIsLoading(true);
    try {
      // SSO members have no password, so a password attempt on an SSO domain could only ever fail
      // with "Invalid credentials". Check first and route them to SSO instead. A failed lookup
      // counts as "no SSO", so a network blip never blocks a password login.
      if (looksLikeEmail(email) && await ssoAvailable(email)) {
        setIsLoading(false);
        setView('sso');
        await runSso();
        return;
      }
      handleOutcome(await login(email, password));
    } catch (error) {
      setFormError(describeLoginError(error, 'Invalid email or password.'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleAnonymousLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!accountNumber) {
      setFormError('Please enter your account number.');
      return;
    }

    setIsLoading(true);
    try {
      const cleanedAccountNumber = accountNumber.replace(/\D/g, '');
      handleOutcome(await anonymousLogin(cleanedAccountNumber));
    } catch (error) {
      setFormError(describeLoginError(error, 'Invalid account number.'));
    } finally {
      setIsLoading(false);
    }
  };

  // "Sign in with SSO": a valid email goes straight to the browser, anything else opens the
  // work-email step.
  const handleSsoButton = async () => {
    setFormError(null);
    if (looksLikeEmail(email)) {
      setView('sso');
      await runSso();
    } else {
      setView('sso');
    }
  };

  const handleSsoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!looksLikeEmail(email)) {
      setFormError('Enter a valid work email address.');
      return;
    }
    await runSso();
  };

  const handleCancelSso = async () => {
    await cancelSso();
    setSsoWaiting(false);
  };

  const backToLogin = () => {
    // Backing out of the code screen abandons the challenge; do not keep it around.
    setTwoFactorChallenge(null);
    setFormError(null);
    setView('login');
  };

  const handleTwoFactorSubmit = async (code: string) => {
    if (!twoFactorChallenge) return;
    try {
      await verifyTwoFactor(twoFactorChallenge, code);
      navigate('/dashboard');
    } catch (error) {
      if (isChallengeExpired(error)) {
        // The sign-in timed out: send them back to the password step to start again.
        backToLogin();
        setFormError(describeTwoFactorError(error));
        return;
      }
      throw error;
    }
  };

  const handleEmergencyReset = async () => {
    setResetting(true);
    setFormError(null);
    try {
      await window.electronAPI!.vpn.emergencyReset();
    } catch (err) {
      setFormError('Emergency reset failed. Please restart the application.');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-background">
      <TitleBar />
    <div className="flex-1 flex items-center justify-center p-4 star-pattern relative overflow-hidden">
      {/* Decorative Background Elements */}
      <div className="absolute inset-0 tactical-grid opacity-20" />
      <div className="absolute top-0 left-0 w-96 h-96 bg-patriot-blue/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 right-0 w-96 h-96 bg-patriot-red/10 rounded-full blur-3xl" />
      
      <div className="relative z-10 w-full max-w-md animate-fade-in-up">
        {/* Logo Header */}
        <div className="text-center mb-8 flex flex-col items-center">
          <img
            src={Logo}
            alt="WireDog VPN Logo"
            className="w-24 h-24 object-contain mx-auto"
          />
          <img
            src={TextLogo}
            alt="WireDog"
            className="w-60 h-auto"
          />
          <div className="flex items-center justify-center">
          </div>
          <p className="text-muted-foreground">
            Built for Americans, by Americans
          </p>
        </div>

        {/* Login Card */}
        <Card className="p-6 border-border/50 backdrop-blur-sm">
          {view === 'twoFactor' ? (
            <TwoFactorCodeForm
              onSubmit={handleTwoFactorSubmit}
              describeError={describeTwoFactorError}
              onBack={backToLogin}
            />
          ) : view === 'sso' ? (
            <form onSubmit={handleSsoSubmit} className="space-y-4">
              <div className="flex flex-col items-center text-center gap-2 mb-2">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                  <Building2 className="w-6 h-6 text-muted-foreground" />
                </div>
                <h2 className="font-display text-xl tracking-wide">SINGLE SIGN-ON</h2>
                <p className="text-sm text-muted-foreground">
                  Sign in with your organization. Your browser will open to your company's sign-in page.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Work Email</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="email"
                    placeholder="Work Email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setFormError(null); }}
                    disabled={ssoWaiting}
                    autoFocus
                    className="pl-10"
                  />
                </div>
              </div>

              {formError && <p className="text-sm text-red-400" role="alert">{formError}</p>}

              {ssoWaiting ? (
                <>
                  <Button type="button" variant="patriot" size="lg" className="w-full" disabled>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Waiting for your browser...
                  </Button>
                  <button
                    type="button"
                    onClick={handleCancelSso}
                    className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <Button
                    type="submit"
                    variant="patriot"
                    size="lg"
                    className="w-full"
                    disabled={!email.trim()}
                  >
                    Sign in with SSO
                  </Button>
                  <button
                    type="button"
                    onClick={backToLogin}
                    className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Back to sign in
                  </button>
                </>
              )}
            </form>
          ) : (
          <Tabs defaultValue="standard" className="w-full" onValueChange={() => setFormError(null)}>
            <TabsList className="grid w-full grid-cols-2 mb-6">
              <TabsTrigger value="standard" className="flex items-center gap-2">
                <User className="w-4 h-4" />
                Standard Login
              </TabsTrigger>
              <TabsTrigger value="anonymous" className="flex items-center gap-2">
                <Hash className="w-4 h-4" />
                Anonymous
              </TabsTrigger>
            </TabsList>

            <TabsContent value="standard">
              <form onSubmit={handleStandardLogin} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Email</label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="email"
                      placeholder="Enter your email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                </div>
                
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Password</label>
                  <div className="relative">
                    <Key className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="password"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                </div>

                {formError && <p className="text-sm text-red-400" role="alert">{formError}</p>}

                <Button
                  type="submit"
                  variant="patriot"
                  size="lg"
                  className="w-full"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Signing In...
                    </>
                  ) : (
                    'Sign In'
                  )}
                </Button>

                <div className="flex items-center justify-between text-sm">
                  <button
                    type="button"
                    onClick={() => navigate('/forgot-password', { state: { email } })}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Forgot password?
                  </button>
                  {/* Business employees whose organization uses single sign-on */}
                  <button
                    type="button"
                    onClick={handleSsoButton}
                    disabled={isLoading}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Sign in with SSO
                  </button>
                </div>
              </form>
            </TabsContent>

            <TabsContent value="anonymous">
              <form onSubmit={handleAnonymousLogin} className="space-y-4">
                <div className="bg-muted/50 rounded-lg p-4 mb-4">
                  <p className="text-sm text-muted-foreground">
                    Anonymous login provides maximum privacy. Enter only your account number to connect.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Account Number</label>
                  <div className="relative">
                    <Hash className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder="XXXX-XXXX-XXXX-XXXX"
                      value={accountNumber}
                      onChange={(e) => setAccountNumber(formatAccountNumber(e.target.value))}
                      className="pl-10 font-mono"
                    />
                  </div>
                </div>

                {formError && <p className="text-sm text-red-400" role="alert">{formError}</p>}

                <Button
                  type="submit"
                  variant="patriot"
                  size="lg"
                  className="w-full"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    'Anonymous Login'
                  )}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
          )}
        </Card>

        {/* Create Account Link */}
        <div className="text-center mt-6">
          <p className="text-sm text-muted-foreground">
            Don't have an account?{' '}
            <button
              onClick={() => navigate('/create-account')}
              className="font-medium text-patriot-red hover:text-patriot-red/80 transition-colors"
            >
              Create an Account
            </button>
          </p>
        </div>

        {/* Emergency Reset — last resort if WFP filters are blocking login */}
        {window.electronAPI?.vpn && (
          <div className="mt-6">
            <button
              onClick={handleEmergencyReset}
              disabled={resetting}
              className="w-full py-2 px-4 rounded-lg border border-red-500/30 bg-red-500/5 text-red-400/70 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/50 transition-colors text-xs"
            >
              {resetting ? 'Resetting...' : 'Emergency Reset — Clear All Network Filters'}
            </button>
            <p className="text-xs text-muted-foreground/50 text-center mt-1">
              Use only if network is blocked and you cannot connect
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="text-center mt-6 text-sm text-muted-foreground">
          <p>Privacy • Freedom • Trust</p>
          <p className="text-xs mt-1">© 2026 WireDog VPN. All rights reserved.</p>
        </div>
      </div>
    </div>
    </div>
  );
};

export default Login;
