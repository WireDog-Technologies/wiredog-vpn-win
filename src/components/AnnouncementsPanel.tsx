import React from 'react';
import { X, Mail, Info, Wrench, AlertTriangle, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Announcement, AnnouncementSeverity } from '@/types/announcements';

interface AnnouncementsPanelProps {
  open: boolean;
  messages: Announcement[];
  readIds: Set<string>;
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onClose: () => void;
}

const severityStyles: Record<AnnouncementSeverity, { icon: React.ElementType; color: string }> = {
  info: { icon: Info, color: 'text-accent' },
  maintenance: { icon: Wrench, color: 'text-patriot-gold' },
  incident: { icon: AlertTriangle, color: 'text-patriot-red' },
};

const AnnouncementsPanel: React.FC<AnnouncementsPanelProps> = ({
  open,
  messages,
  readIds,
  onMarkRead,
  onMarkUnread,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl w-full max-w-md mx-4 max-h-[70vh] flex flex-col shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <h3 className="font-display text-lg tracking-wide text-foreground">Announcements</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-2">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Mail className="w-9 h-9 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No announcements right now</p>
            </div>
          ) : (
            messages.map((message) => {
              const isRead = readIds.has(message.id);
              const { icon: SeverityIcon, color } = severityStyles[message.severity];
              return (
                <div
                  key={message.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => !isRead && onMarkRead(message.id)}
                  className={cn(
                    'group flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer',
                    isRead
                      ? 'bg-muted/30 border-transparent'
                      : `${color.replace('text-', 'bg-')}/10 border-current ${color}`
                  )}
                >
                  <SeverityIcon className={cn('w-5 h-5 flex-shrink-0 mt-0.5', isRead ? 'text-muted-foreground' : color)} />
                  <div className="flex-1 min-w-0">
                    <p className={cn('text-sm leading-tight', isRead ? 'font-normal text-muted-foreground' : 'font-bold text-foreground')}>
                      {message.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 leading-snug">{message.body}</p>
                    <p className="text-[11px] text-muted-foreground/70 mt-1.5">
                      {new Date(message.startAt).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                  </div>
                  {isRead ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onMarkUnread(message.id);
                      }}
                      title="Mark unread"
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity flex-shrink-0"
                    >
                      <Undo2 className="w-4 h-4" />
                    </button>
                  ) : (
                    <span className={cn('w-2 h-2 rounded-full flex-shrink-0 mt-1.5', color.replace('text-', 'bg-'))} />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default AnnouncementsPanel;
