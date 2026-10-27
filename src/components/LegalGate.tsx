import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { LegalVersions } from '@/types/vpn';
import TitleBar from '@/components/layout/TitleBar';
import {
  ACCEPTED_PRIVACY_KEY,
  ACCEPTED_TERMS_KEY,
  PRIVACY_URL,
  TERMS_URL,
  isLegalUpdate,
  pendingLegal,
} from '@/lib/legal';

const openLink = (url: string) => {
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
};

/**
 * Blocks the app until the user has accepted the currently published Privacy Policy and Terms of
 * Service. Each document is tracked by its own version, so a bump to one only re-prompts for that
 * one. Re-checked whenever the window regains focus, without waiting for a relaunch.
 */
const LegalGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [legal, setLegal] = useState<LegalVersions | null>(null);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState('');

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.getLegalConfig) return;
    try {
      const [config, settings] = await Promise.all([
        window.electronAPI.getLegalConfig(),
        window.electronAPI.getSettings(),
      ]);
      setAcceptedPrivacy(String(settings?.[ACCEPTED_PRIVACY_KEY] ?? ''));
      setAcceptedTerms(String(settings?.[ACCEPTED_TERMS_KEY] ?? ''));
      // A failed fetch keeps the last known config instead of clearing it.
      if (config) setLegal(config);
    } catch (error) {
      console.warn('Legal config check failed:', error);
    }
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const pending = pendingLegal(legal, acceptedPrivacy, acceptedTerms);
  if (pending.size === 0 || !legal) return <>{children}</>;

  const isUpdate = isLegalUpdate(acceptedPrivacy, acceptedTerms);
  const both = pending.has('privacy') && pending.has('terms');
  const what = both ? 'Privacy Policy and Terms of Service' : pending.has('privacy') ? 'Privacy Policy' : 'Terms of Service';

  // Only record versions for documents actually shown.
  const accept = async () => {
    const update: Record<string, string> = {};
    if (pending.has('privacy')) update[ACCEPTED_PRIVACY_KEY] = legal.privacyVersion;
    if (pending.has('terms')) update[ACCEPTED_TERMS_KEY] = legal.termsVersion;
    try {
      await window.electronAPI?.setSettings?.(update);
    } finally {
      if (update[ACCEPTED_PRIVACY_KEY]) setAcceptedPrivacy(update[ACCEPTED_PRIVACY_KEY]);
      if (update[ACCEPTED_TERMS_KEY]) setAcceptedTerms(update[ACCEPTED_TERMS_KEY]);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-background">
      <TitleBar />
    <div className="flex-1 flex items-center justify-center p-4 star-pattern relative overflow-hidden">
      <div className="absolute inset-0 tactical-grid opacity-20" />
      <div className="relative z-10 w-full max-w-lg animate-fade-in-up">
        <Card className="p-8 border-border/50 backdrop-blur-sm">
          <div className="flex flex-col items-center text-center gap-3 mb-6">
            <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center">
              <ScrollText className="w-7 h-7 text-muted-foreground" />
            </div>
            <h1 className="font-display text-2xl tracking-wide">
              {isUpdate ? `UPDATED ${what.toUpperCase()}` : what.toUpperCase()}
            </h1>
            <p className="text-sm text-muted-foreground">
              {isUpdate
                ? `We've updated our ${what}. Please review and accept to keep using WireDog VPN.`
                : `Please review and accept our ${what} to continue.`}
            </p>
            {legal.summary && <p className="text-sm text-foreground">{legal.summary}</p>}
          </div>

          <div className="space-y-2 mb-6">
            {pending.has('privacy') && (
              <button
                onClick={() => openLink(PRIVACY_URL)}
                className="w-full flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors text-sm"
              >
                <span>Privacy Policy</span>
                <ExternalLink className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
            {pending.has('terms') && (
              <button
                onClick={() => openLink(TERMS_URL)}
                className="w-full flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors text-sm"
              >
                <span>Terms of Service</span>
                <ExternalLink className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
          </div>

          <div className="space-y-3">
            <Button variant="patriot" size="lg" className="w-full" onClick={accept}>
              I Agree
            </Button>
            <button
              onClick={() => window.electronAPI?.quitApp?.()}
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Decline and Quit
            </button>
          </div>
        </Card>
      </div>
    </div>
    </div>
  );
};

export default LegalGate;
