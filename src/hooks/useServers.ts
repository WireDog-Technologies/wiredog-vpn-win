import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getServers } from '@/lib/api';
import { transformServer } from '@/lib/servers';
import { useVPN } from '@/context/VPNContext';
import { ServerLocation } from '@/types/vpn';
import { servers as fallbackServers } from '@/data/servers';
import { useLatency } from '@/hooks/useLatency';

export function useServers() {
  // The list depends on who is signed in: an organization member gets named Dedicated IP gateway
  // entries, and may be restricted to the organization's own network. Keying the query on the
  // account refetches it whenever the signed-in account changes (sign-in, sign-out).
  const { user } = useVPN();
  return useQuery({
    queryKey: ['vpn-servers', user?.id ?? 'signed-out'],
    queryFn: async () => {
      try {
        const servers = await getServers();
        // An empty list is a real answer (a business plan restricted to the organization's own
        // network with no location set up); don't mask it with the static fallback.
        return servers.map(transformServer);
      } catch {
        // API unavailable, use fallback servers
        return fallbackServers;
      }
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: false, // Don't retry if API fails
  });
}

export function useServersByState() {
  const { data: servers = [], ...rest } = useServers();

  const grouped: Record<string, ServerLocation[]> = {};
  servers.forEach(server => {
    if (!grouped[server.state]) {
      grouped[server.state] = [];
    }
    grouped[server.state].push(server);
  });

  return { data: grouped, servers, ...rest };
}

export function useRecommendedServers() {
  const { data: servers = [], ...rest } = useServers();
  return { data: servers.filter(s => s.recommended), ...rest };
}

export function useServerById(id: string) {
  const { data: servers = [], ...rest } = useServers();
  return { data: servers.find(s => s.id === id), ...rest };
}

// Returns servers with live-measured latency merged in
export function useServersWithLatency() {
  const { data: servers = [], ...rest } = useServers();
  const latencyMap = useLatency(servers);

  const data = useMemo(() => {
    if (Object.keys(latencyMap).length === 0) return servers;
    return servers.map(s =>
      latencyMap[s.id] !== undefined ? { ...s, latency: latencyMap[s.id] } : s
    );
  }, [servers, latencyMap]);

  return { data, ...rest };
}
