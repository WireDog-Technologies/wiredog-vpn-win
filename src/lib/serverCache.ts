import type { ServerLocation } from '@/types/vpn';

// The last server list the backend really returned, kept on this machine so the list can still be
// shown (and an auto-connect still has a real server to pick) when the backend cannot be reached,
// for example while the kill switch is blocking. Nothing here is ever invented: if no real list has
// been saved, there is no list.
const KEY = 'wiredog.serverList.v1';

interface CachedList {
  userId: string;
  servers: ServerLocation[];
}

function read(): CachedList | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedList;
    return parsed && typeof parsed.userId === 'string' && Array.isArray(parsed.servers) ? parsed : null;
  } catch {
    return null;
  }
}

/** The saved list for this account (an organization member's list differs), or undefined. */
export function loadCachedServers(userId: string | undefined): ServerLocation[] | undefined {
  if (!userId) return undefined;
  const cached = read();
  return cached && cached.userId === userId && cached.servers.length > 0 ? cached.servers : undefined;
}

export function saveCachedServers(userId: string, servers: ServerLocation[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ userId, servers } satisfies CachedList));
  } catch {
    /* storage unavailable: the list just is not kept */
  }
}

/** A server from the saved list by its list id, for display lookups and the startup auto-connect. */
export function getCachedServerById(id: string): ServerLocation | undefined {
  return read()?.servers.find(s => s.id === id);
}
