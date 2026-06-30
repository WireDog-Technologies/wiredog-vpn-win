import React from 'react';
import { Lock } from 'lucide-react';

interface DisconnectDialogProps {
  open: boolean;
  onDisconnect: () => void;           // Keep protection active (PersistentBlock)
  onDisconnectAndDisable: () => void; // Remove all protection
  onCancel: () => void;
}

const DisconnectDialog: React.FC<DisconnectDialogProps> = ({
  open,
  onDisconnect,
  onDisconnectAndDisable,
  onCancel,
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-xl p-6 max-w-sm mx-4 shadow-lg">
        <div className="flex items-center gap-3 mb-3">
          <Lock className="w-5 h-5 text-amber-500" />
          <h3 className="font-display text-lg tracking-wide text-foreground">
            Disconnect VPN
          </h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Always-On Kill Switch is active. Choose how to disconnect.
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onDisconnect}
            className="w-full px-4 py-2 bg-connection-active text-background rounded-lg text-sm font-medium hover:bg-connection-active/90 transition-colors text-left"
          >
            <span className="block">Disconnect — Stay Protected</span>
            <span className="block opacity-70 text-xs mt-0.5">VPN disconnects but all internet stays blocked until you reconnect</span>
          </button>
          <button
            onClick={onDisconnectAndDisable}
            className="w-full px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium hover:bg-destructive/90 transition-colors text-left"
          >
            <span className="block">Disconnect — Turn Off Always-On</span>
            <span className="block opacity-70 text-xs mt-0.5">VPN disconnects and normal internet access is restored</span>
          </button>
          <button
            onClick={onCancel}
            className="w-full px-4 py-2 bg-muted text-muted-foreground rounded-lg text-sm font-medium hover:bg-muted/80 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default DisconnectDialog;
