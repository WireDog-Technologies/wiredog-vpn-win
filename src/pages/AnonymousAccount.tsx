import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, AlertTriangle, Copy, Loader2, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import TitleBar from '@/components/layout/TitleBar';
import * as api from '@/lib/api';
import Logo from '../assets/logos/wiredog-minimal-navy_1024x1024.png';
import TextLogo from '../assets/logos/wiredog_text_logo_1024.png';

const AnonymousAccount: React.FC = () => {
  const navigate = useNavigate();
  const { anonymousLogin } = useVPN();

  const [accountNumber, setAccountNumber] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const createAccount = async () => {
    setIsCreating(true);
    setError('');
    try {
      const number = await api.registerAnonymous();
      setAccountNumber(number);
    } catch (err: any) {
      console.error('Anonymous account creation failed:', err);
      setError(err?.message || 'Failed to create account. Please try again.');
    } finally {
      setIsCreating(false);
    }
  };

  useEffect(() => {
    createAccount();
  }, []);

  const handleCopy = async () => {
    if (!accountNumber) return;
    try {
      await navigator.clipboard.writeText(accountNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  const handleGotIt = async () => {
    if (!accountNumber) return;
    setIsLoggingIn(true);
    try {
      const cleaned = accountNumber.replace(/\D/g, '');
      await anonymousLogin(cleaned);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err?.message || 'Auto-login failed. Please sign in manually.');
      setIsLoggingIn(false);
    }
  };

  const formattedNumber = accountNumber
    ? accountNumber.replace(/\D/g, '').match(/.{1,4}/g)?.join('-') ?? accountNumber
    : '';

  return (
    <div className="flex flex-col h-screen bg-background">
      <TitleBar />
      <div className="flex-1 flex items-center justify-center p-4 star-pattern relative overflow-hidden">
        <div className="absolute inset-0 tactical-grid opacity-20" />
        <div className="absolute top-0 left-0 w-96 h-96 bg-patriot-blue/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-patriot-red/10 rounded-full blur-3xl" />

        <div className="relative z-10 w-full max-w-md animate-fade-in-up">
          {isCreating && (
            <button
              onClick={() => navigate('/create-account')}
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-6 text-sm font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          )}

          <div className="text-center mb-8 flex flex-col items-center">
            <img src={Logo} alt="WireDog VPN Logo" className="w-20 h-20 object-contain mx-auto" />
            <img src={TextLogo} alt="WireDog" className="w-52 h-auto" />
          </div>

          <Card className="p-6 border-border/50 backdrop-blur-sm">
            {isCreating ? (
              <div className="flex flex-col items-center py-8 gap-4">
                <Loader2 className="w-10 h-10 animate-spin text-patriot-red" />
                <div className="text-center">
                  <p className="font-semibold text-foreground">Creating Your Account</p>
                  <p className="text-sm text-muted-foreground mt-1">This will only take a moment...</p>
                </div>
              </div>
            ) : error && !accountNumber ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
                  <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
                  <p className="text-sm text-red-400">{error}</p>
                </div>
                <Button variant="patriot" size="lg" className="w-full" onClick={createAccount}>
                  Try Again
                </Button>
                <button
                  onClick={() => navigate('/create-account')}
                  className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Go Back
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex flex-col items-center gap-2 text-center">
                  <CheckCircle className="w-12 h-12 text-green-500" />
                  <h1 className="text-2xl font-bold text-foreground">Account Created!</h1>
                  <p className="text-sm text-muted-foreground">Your anonymous account is ready</p>
                </div>

                <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50 border border-border/50">
                  <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">Keep This Number Safe</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      This account number is your only way to log in. Save it somewhere secure — it cannot be recovered.
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Your Account Number
                  </p>
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 border border-border/50">
                    <span className="font-mono text-lg font-semibold text-foreground tracking-widest flex-1">
                      {formattedNumber}
                    </span>
                    <button
                      onClick={handleCopy}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title="Copy to clipboard"
                    >
                      <Copy className="w-5 h-5" />
                    </button>
                  </div>
                  {copied && (
                    <p className="text-xs text-green-500 font-semibold">Copied to clipboard!</p>
                  )}
                </div>

                {error && (
                  <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}

                <div className="space-y-3">
                  <Button
                    variant="patriot"
                    size="lg"
                    className="w-full"
                    onClick={handleGotIt}
                    disabled={isLoggingIn}
                  >
                    {isLoggingIn ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Signing In...
                      </>
                    ) : (
                      'Got It — Sign Me In'
                    )}
                  </Button>

                  <button
                    onClick={() => navigate('/')}
                    className="w-full py-2 px-4 rounded-lg border border-red-500/50 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors text-sm font-medium"
                  >
                    Discard Account
                  </button>
                </div>
              </div>
            )}
          </Card>

          {!isCreating && (
            <div className="text-center mt-6">
              <p className="text-sm text-muted-foreground">
                Already have an account?{' '}
                <button
                  onClick={() => navigate('/')}
                  className="font-medium text-patriot-red hover:text-patriot-red/80 transition-colors"
                >
                  Login
                </button>
              </p>
            </div>
          )}

          <div className="text-center mt-6 text-sm text-muted-foreground">
            <p>Privacy • Freedom • Trust</p>
            <p className="text-xs mt-1">© 2026 WireDog VPN. All rights reserved.</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnonymousAccount;
