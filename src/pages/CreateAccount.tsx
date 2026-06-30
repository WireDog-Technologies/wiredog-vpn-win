import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, UserX, ChevronRight, Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import TitleBar from '@/components/layout/TitleBar';
import Logo from '../assets/logos/wiredog-minimal-navy_1024x1024.png';
import TextLogo from '../assets/logos/wiredog_text_logo_1024.png';

const CreateAccount: React.FC = () => {
  const navigate = useNavigate();

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
              <h1 className="text-2xl font-bold text-foreground">Create an Account</h1>
              <p className="text-sm text-muted-foreground mt-1">Choose your account type</p>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => navigate('/create-account/standard')}
                className="w-full flex items-center gap-4 p-4 rounded-lg bg-muted/50 border border-border/50 hover:bg-muted transition-colors text-left"
              >
                <div className="w-12 h-12 rounded-lg bg-background flex items-center justify-center shrink-0">
                  <Mail className="w-6 h-6 text-patriot-red" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground">Standard Account</p>
                  <p className="text-sm text-muted-foreground">Email and password required</p>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
              </button>

              <button
                onClick={() => navigate('/create-account/anonymous')}
                className="w-full flex items-center gap-4 p-4 rounded-lg bg-muted/50 border border-border/50 hover:bg-muted transition-colors text-left"
              >
                <div className="w-12 h-12 rounded-lg bg-background flex items-center justify-center shrink-0">
                  <UserX className="w-6 h-6 text-patriot-red" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground">Anonymous Account</p>
                  <p className="text-sm text-muted-foreground">16-digit account number only</p>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
              </button>
            </div>

            <div className="mt-5 p-4 rounded-lg bg-muted/50 border border-border/50">
              <div className="flex items-center gap-2 mb-2">
                <Info className="w-4 h-4 text-patriot-red shrink-0" />
                <span className="text-sm font-semibold text-foreground">What's the difference?</span>
              </div>
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                <li className="flex gap-2">
                  <span>•</span>
                  <span>Standard: Email and password login, account recovery, and management</span>
                </li>
                <li className="flex gap-2">
                  <span>•</span>
                  <span>Anonymous: Log in with only a 16-digit account number, maximum privacy</span>
                </li>
              </ul>
            </div>
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

export default CreateAccount;
