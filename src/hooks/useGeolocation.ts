import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVPN } from '@/context/VPNContext';

interface GeoLocation {
  ip: string;
  city: string;
  region: string;
  country: string;
}

// Last successful lookup, kept in memory only (never written to disk or the logs). Shown as
// the last known value while a block makes a new lookup impossible, so the screen is not stuck on "Redacted".
let lastKnownGeo: GeoLocation | null = null;

export function useGeolocation(connectionStatus?: string) {
  const { isStatusResolved, advancedKillSwitchActive } = useVPN();
  const queryClient = useQueryClient();

  // When the block lifts (Disconnect fully, Emergency Reset, reconnect), look up again right away:
  // the network may have changed while it was up, and the old answer may still count as fresh.
  const wasBlocked = useRef(advancedKillSwitchActive);
  useEffect(() => {
    if (wasBlocked.current && !advancedKillSwitchActive) {
      queryClient.invalidateQueries({ queryKey: ['geolocation'] });
    }
    wasBlocked.current = advancedKillSwitchActive;
  }, [advancedKillSwitchActive, queryClient]);

  const query = useQuery({
    queryKey: ['geolocation', connectionStatus],
    queryFn: async (): Promise<GeoLocation> => {
      let geo: GeoLocation;
      // Try Electron IPC path first
      if (window.electronAPI?.getGeolocation) {
        geo = await window.electronAPI.getGeolocation();
      } else {
        // Fallback: fetch from ipify + ipapi
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        const ipv4 = ipData.ip;

        const geoResponse = await fetch(`https://ipapi.co/${ipv4}/json/`);
        const geoData = await geoResponse.json();

        geo = {
          ip: ipv4,
          city: geoData.city,
          region: geoData.region,
          country: geoData.country_name,
        };
      }
      // A failed lookup ("Redacted") must be an error, not an answer: an answer is cached for 5 minutes,
      // which kept the screen on "Redacted" after the network came back.
      if (!geo || !geo.ip || geo.ip === 'Redacted') throw new Error('Geolocation lookup failed');
      lastKnownGeo = geo;
      return geo;
    },
    // Only look up the real IP/location while genuinely disconnected. When connected, the exit IP
    // comes from the backend's /vpn/connect response instead of a lookup through the tunnel, and
    // until the first tunnel-status read lands the app may have been relaunched with the tunnel
    // already up, so a lookup then would hand the exit IP to a third party.
    // Not while the persistent block is up either: it would only fail.
    enabled: isStatusResolved && connectionStatus === 'disconnected' && !advancedKillSwitchActive,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  return {
    ...query,
    data: query.data ?? lastKnownGeo ?? undefined,
  };
}
