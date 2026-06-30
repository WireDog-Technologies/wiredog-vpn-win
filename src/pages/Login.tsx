import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Key, Hash, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useVPN } from '@/context/VPNContext';
import TitleBar from '@/components/layout/TitleBar';
import Logo from "../assets/logos/wiredog-minimal-navy_1024x1024.png";
import TextLogo from "../assets/logos/wiredog_text_logo_1024.png";

const Login: React.FC = () => {
  const navigate = useNavigate();
  const { login, anonymousLogin } = useVPN();

  const [isLoading, setIsLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [error, setError] = useState('');

  const formatAccountNumber = (value: string): string => {
    const cleaned = value.replace(/\D/g, '');
    const chunks = cleaned.match(/.{1,4}/g) || [];
    return chunks.join('-');
  };

  const handleStandardLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('Please fill in all fields');
      return;
    }

    setIsLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err) {
      setError('Invalid credentials');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAnonymousLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!accountNumber) {
      setError('Please enter your account number');
      return;
    }

    setIsLoading(true);
    try {
      const cleanedAccountNumber = accountNumber.replace(/\D/g, '');
      await anonymousLogin(cleanedAccountNumber);
      navigate('/dashboard');
    } catch (err) {
      setError('Invalid account number');
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmergencyReset = async () => {
    setResetting(true);
    setError('');
    try {
      await window.electronAPI!.vpn.emergencyReset();
    } catch (err) {
      setError('Emergency reset failed. Please restart the application.');
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
          <Tabs defaultValue="standard" className="w-full" onValueChange={() => setError('')}>
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

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-4">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

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
