import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getServers, ServerResponse } from '@/lib/api';
import { ServerLocation } from '@/types/vpn';
import { servers as fallbackServers } from '@/data/servers';
import { useLatency } from '@/hooks/useLatency';

// Transform backend response to frontend ServerLocation type
function transformServer(server: ServerResponse): ServerLocation {
  return {
    id: server.id,
    state: server.state,
    stateCode: server.stateCode,
    city: server.city,
    latitude: server.latitude ?? 0,
    longitude: server.longitude ?? 0,
    latency: server.latency,
    load: server.load,
    recommended: server.isRecommended,
    host: server.host,
  };
}

export function useServers() {
  return useQuery({
    queryKey: ['vpn-servers'],
    queryFn: async () => {
      try {
        const servers = await getServers();
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
