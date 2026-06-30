import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Key, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import TitleBar from '@/components/layout/TitleBar';
import * as api from '@/lib/api';
import Logo from '../assets/logos/wiredog-minimal-navy_1024x1024.png';
import TextLogo from '../assets/logos/wiredog_text_logo_1024.png';

const MAX_EMAIL = 128;
const MAX_PASSWORD = 64;

function sanitizeEmail(value: string): string {
  return value.replace(/[^a-zA-Z0-9@.+\-_]/g, '').slice(0, MAX_EMAIL);
}

function sanitizePassword(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '').slice(0, MAX_PASSWORD);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const StandardAccount: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useVPN();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!isValidEmail(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (!/[a-zA-Z]/.test(password)) {
      setError('Password must contain at least one letter.');
      return;
    }
    if (!/[0-9]/.test(password)) {
      setError('Password must contain at least one number.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setIsLoading(true);
    try {
      await api.registerStandard(email, password);
      await login(email, password);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err?.message || 'Failed to create account. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-background">
      <TitleBar />
      <div className="flex-1 flex items-center justify-center p-4 star-pattern relative overflow-hidden">
        <div className="absolute inset-0 tactical-grid opacity-20" />
        <div className="absolute top-0 left-0 w-96 h-96 bg-patriot-blue/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-patriot-red/10 rounded-full blur-3xl" />

        <div className="relative z-10 w-full max-w-md animate-fade-in-up">
          <div className="text-center mb-8 flex flex-col items-center">
            <img src={Logo} alt="WireDog VPN Logo" className="w-20 h-20 object-contain mx-auto" />
            <img src={TextLogo} alt="WireDog" className="w-52 h-auto" />
          </div>

          <Card className="p-6 border-border/50 backdrop-blur-sm">
            <div className="mb-6">
              <h1 className="text-2xl font-bold text-foreground">Create Standard Account</h1>
              <p className="text-sm text-muted-foreground mt-1">Sign up with your email and password</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Email</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="email"
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => setEmail(sanitizeEmail(e.target.value))}
                    className="pl-10"
                    autoComplete="email"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Password</label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="password"
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => setPassword(sanitizePassword(e.target.value))}
                    className="pl-10"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Confirm Password</label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="password"
                    placeholder="Confirm password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(sanitizePassword(e.target.value))}
                    className="pl-10"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                variant="patriot"
                size="lg"
                className="w-full"
                disabled={isLoading || !email || !password || !confirmPassword}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating Account...
                  </>
                ) : (
                  'Create Account'
                )}
              </Button>
            </form>
          </Card>

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

          <div className="text-center mt-6 text-sm text-muted-foreground">
            <p>Privacy • Freedom • Trust</p>
            <p className="text-xs mt-1">© 2026 WireDog VPN. All rights reserved.</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StandardAccount;
