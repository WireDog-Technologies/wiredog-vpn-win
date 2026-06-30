import React, { useEffect, useState } from 'react';
import { AlertTriangle, Download, RefreshCw, Wrench, CheckCircle, ChevronDown, LogOut } from 'lucide-react';
import { useAutoUpdate } from '@/hooks/useAutoUpdate';

const UpdateDialog: React.FC = () => {
  const {
    updateStatus,
    updateInfo,
    downloadProgress,
    dismissed,
    downloadUpdate,
    installUpdate,
    dismissUpdate,
  } = useAutoUpdate();

  // Nothing to show
  if (updateStatus === 'idle' || updateStatus === 'checking') return null;

  // User dismissed optional update or maintenance
  if (dismissed && (updateStatus === 'available' || updateStatus === 'maintenance')) return null;

  // Maintenance mode — dismissible overlay
  if (updateStatus === 'maintenance') {
    return (
      <Overlay dismissible onDismiss={dismissUpdate}>
        <CenterCard>
          <div className="flex flex-col items-center text-center gap-4">
            <div className="w-14 h-14 rounded-full bg-yellow-500/10 flex items-center justify-center">
              <Wrench className="w-7 h-7 text-yellow-500" />
            </div>
            <h2 className="font-display text-2xl tracking-wide text-foreground">
              Under Maintenance
            </h2>
            <p className="text-muted-foreground text-sm max-w-sm">
              WireDog VPN is undergoing maintenance. Please try again later.
            </p>
            <UpdateDetails message={updateInfo.message} />
          </div>
        </CenterCard>
      </Overlay>
    );
  }

  // Force update — non-dismissible blocking overlay
  if (updateStatus === 'force-required') {
    return (
      <Overlay>
        <CenterCard>
          <div className="flex flex-col items-center text-center gap-4">
            <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="w-7 h-7 text-destructive" />
            </div>
            <h2 className="font-display text-2xl tracking-wide text-foreground">
              Update Required
            </h2>
            <p className="text-muted-foreground text-sm max-w-sm">
              This version of WireDog VPN is no longer supported. Please update to continue.
            </p>
            <UpdateDetails message={updateInfo.message} />
            <button
              onClick={downloadUpdate}
              className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              Update Now
            </button>
            <button
              onClick={() => {
                if (window.electronAPI?.quitApp) {
                  window.electronAPI.quitApp();
                }
              }}
              className="w-full px-6 py-2 bg-muted text-muted-foreground rounded-lg hover:bg-muted/80 transition-colors font-medium flex items-center justify-center gap-2 text-sm"
            >
              <LogOut className="w-4 h-4" />
              Quit WireDog VPN
            </button>
          </div>
        </CenterCard>
      </Overlay>
    );
  }

  // Downloading — progress display (top banner)
  if (updateStatus === 'downloading') {
    const percent = downloadProgress?.percent || 0;
    return (
      <TopBanner>
        <div className="flex items-center gap-4">
          <Download className="w-5 h-5 text-primary animate-pulse flex-shrink-0" />
          <div className="flex-1">
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
          <span className="text-sm text-muted-foreground flex-shrink-0">{percent}%</span>
        </div>
      </TopBanner>
    );
  }

  // Downloaded — restart prompt (top banner)
  if (updateStatus === 'downloaded') {
    return (
      <TopBanner>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />
            <span className="text-sm text-foreground">Update ready — restart to apply</span>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={installUpdate}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-sm font-medium flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Restart Now
            </button>
            <button
              onClick={dismissUpdate}
              className="px-3 py-1.5 bg-muted text-muted-foreground rounded-md hover:bg-muted/80 transition-colors text-sm font-medium"
            >
              Later
            </button>
          </div>
        </div>
      </TopBanner>
    );
  }

  // Optional update available (top banner with slide-down animation)
  if (updateStatus === 'available') {
    return (
      <TopBanner>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Download className="w-5 h-5 text-primary flex-shrink-0" />
            <span className="text-sm text-foreground">
              A new version of WireDog VPN is available
            </span>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={downloadUpdate}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-sm font-medium flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              Update Now
            </button>
            <button
              onClick={dismissUpdate}
              className="px-3 py-1.5 bg-muted text-muted-foreground rounded-md hover:bg-muted/80 transition-colors text-sm font-medium"
            >
              Later
            </button>
          </div>
        </div>
        {updateInfo.message && (
          <BannerDetails message={updateInfo.message} />
        )}
      </TopBanner>
    );
  }

  return null;
};

// Expandable "Update Details" for centered dialogs (force update, maintenance)
// Only renders when message is not null
const UpdateDetails: React.FC<{ message: string | null }> = ({ message }) => {
  const [expanded, setExpanded] = useState(false);

  if (!message) return null;

  return (
    <div className="w-full text-left">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        Update Details
        <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="mt-2 p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
          {message}
        </div>
      )}
    </div>
  );
};

// Expandable details row for top banner
const BannerDetails: React.FC<{ message: string }> = ({ message }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        Update Details
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
};

// Full-screen overlay for force update and maintenance
const Overlay: React.FC<{
  children: React.ReactNode;
  dismissible?: boolean;
  onDismiss?: () => void;
}> = ({ children, dismissible, onDismiss }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onClick={dismissible && onDismiss ? onDismiss : undefined}
  >
    <div onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  </div>
);

// Centered dialog card (for force update + maintenance)
const CenterCard: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="w-[380px] rounded-xl border bg-card text-card-foreground shadow-lg p-6">
    {children}
  </div>
);

// Top-positioned banner with slide-down animation, offset below titlebar (~40px from top)
const TopBanner: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  return (
    <div
      className={`fixed left-0 right-0 z-50 flex justify-center pointer-events-none transition-all duration-300 ease-out ${
        visible ? 'opacity-100' : 'opacity-0 -translate-y-4'
      }`}
      style={{ top: '40px' }}
    >
      <div className="w-full max-w-2xl mx-4 pointer-events-auto">
        <div className="rounded-lg border bg-card text-card-foreground shadow-lg px-4 py-3">
          {children}
        </div>
      </div>
    </div>
  );
};

export default UpdateDialog;
