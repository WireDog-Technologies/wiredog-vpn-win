import React, { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useVPN } from '@/context/VPNContext';

const AUTO_DISMISS_MS = 6000;

const ConnectionErrorToast: React.FC = () => {
  const { connectionError, clearConnectionError } = useVPN();

  useEffect(() => {
    if (!connectionError) return;
    const timer = setTimeout(clearConnectionError, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [connectionError, clearConnectionError]);

  if (!connectionError) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] w-[360px] max-w-[calc(100vw-2rem)]">
      <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-card shadow-lg p-4">
        <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
        <p className="text-sm text-foreground/90 flex-1">{connectionError}</p>
        <button
          onClick={clearConnectionError}
          className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default ConnectionErrorToast;
