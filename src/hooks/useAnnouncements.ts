import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as api from '@/lib/api';
import { useVPN } from '@/context/VPNContext';
import { loadReadIds, saveReadIds } from '@/lib/announcementReadStore';
import type { Announcement } from '@/types/announcements';

// Poll every 5 minutes (+ jitter) while the app is active, pause while backgrounded —
// react-query's refetchIntervalInBackground: false gives us the pause-when-unfocused
// behavior for free.
const POLLING_INTERVAL_MS = 5 * 60 * 1000;
const POLLING_JITTER_MS = 60 * 1000;

export function useAnnouncements() {
  const { user } = useVPN();
  const accountId = user?.id;

  // Public announcements, shown to everyone.
  const announcementsQuery = useQuery<Announcement[]>({
    queryKey: ['announcements'],
    queryFn: api.getAnnouncements,
    refetchInterval: POLLING_INTERVAL_MS + Math.random() * POLLING_JITTER_MS,
    refetchIntervalInBackground: false,
    staleTime: 60 * 1000,
    retry: false,
  });

  // Notices staff sent to this account only, fetched with the login token and shown in the same
  // inbox. Keyed on the account and only enabled while signed in, so signing out (or switching
  // accounts) drops them immediately.
  const accountMessagesQuery = useQuery<Announcement[]>({
    queryKey: ['account-messages', accountId],
    queryFn: api.getAccountMessages,
    enabled: !!accountId,
    refetchInterval: POLLING_INTERVAL_MS + Math.random() * POLLING_JITTER_MS,
    refetchIntervalInBackground: false,
    staleTime: 60 * 1000,
    retry: false,
  });

  const messages = useMemo(
    () => [
      ...(announcementsQuery.data ?? []),
      ...(accountId ? accountMessagesQuery.data ?? [] : []),
    ],
    [announcementsQuery.data, accountMessagesQuery.data, accountId]
  );

  // Read-ids are only pruned when every list that should have loaded has: otherwise a failed
  // fetch would look like "all those messages are gone" and mark everything unread.
  const allLoaded = announcementsQuery.isSuccess && (!accountId || accountMessagesQuery.isSuccess);

  const [readIds, setReadIds] = useState<Set<string>>(() => loadReadIds());

  // Drops read-ids for announcements the backend no longer returns, so the local read-set
  // doesn't grow forever as old announcements expire/are removed.
  useEffect(() => {
    if (!allLoaded || messages.length === 0) return;
    const currentIds = new Set(messages.map(m => m.id));
    setReadIds(prev => {
      const pruned = new Set(Array.from(prev).filter(id => currentIds.has(id)));
      if (pruned.size === prev.size) return prev;
      saveReadIds(pruned);
      return pruned;
    });
  }, [messages, allLoaded]);

  // The backend query is the source of truth for which announcements are live — no
  // client-side lifecycle filtering.
  const activeMessages = useMemo(
    () => [...messages].sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime()),
    [messages]
  );

  const unreadCount = useMemo(
    () => activeMessages.filter(m => !readIds.has(m.id)).length,
    [activeMessages, readIds]
  );

  const markRead = useCallback((id: string) => {
    setReadIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      saveReadIds(next);
      return next;
    });
  }, []);

  const markUnread = useCallback((id: string) => {
    setReadIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      saveReadIds(next);
      return next;
    });
  }, []);

  return { messages: activeMessages, unreadCount, readIds, markRead, markUnread };
}
