import React from 'react';
import { RefreshCw, Clock } from 'lucide-react';

interface ReconnectDialogProps {
  open: boolean;
  onReconnect: () => void;
  onDismiss: () => void;
}

const ReconnectDialog: React.FC<ReconnectDialogProps> = ({ open, onReconnect, onDismiss }) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-xl p-6 max-w-sm mx-4 shadow-lg">
        <h3 className="font-display text-lg tracking-wide text-foreground mb-2">
          Apply Changes?
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Split tunneling settings have changed. Reconnect now to apply, or apply on next connection.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onReconnect}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-connection-active text-background rounded-lg text-sm font-medium hover:bg-connection-active/90 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Reconnect Now
          </button>
          <button
            onClick={onDismiss}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-muted text-muted-foreground rounded-lg text-sm font-medium hover:bg-muted/80 transition-colors"
          >
            <Clock className="w-4 h-4" />
            Apply Next Time
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReconnectDialog;
