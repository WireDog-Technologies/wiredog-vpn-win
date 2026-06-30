import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface InfoDialogProps {
  title: string;
  message: string;
  onDismiss: () => void;
  confirmLabel?: string;
}

// Reusable blocking dialog for simple "OK to dismiss" warnings (e.g. disconnect
// required before sign out, device limit reached on connect).
const InfoDialog: React.FC<InfoDialogProps> = ({ title, message, onDismiss, confirmLabel = 'OK' }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onClick={onDismiss}
  >
    <div
      className="w-[380px] rounded-xl border bg-card text-card-foreground shadow-lg p-6"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col items-center text-center gap-4">
        <div className="w-14 h-14 rounded-full bg-yellow-500/10 flex items-center justify-center">
          <AlertTriangle className="w-7 h-7 text-yellow-500" />
        </div>
        <h2 className="font-display text-2xl tracking-wide text-foreground">
          {title}
        </h2>
        <p className="text-muted-foreground text-sm max-w-sm">
          {message}
        </p>
        <button
          onClick={onDismiss}
          className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
);

export default InfoDialog;
