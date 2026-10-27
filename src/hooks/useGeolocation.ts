import { useQuery } from '@tanstack/react-query';
import { useVPN } from '@/context/VPNContext';

interface GeoLocation {
  ip: string;
  city: string;
  region: string;
  country: string;
}

export function useGeolocation(connectionStatus?: string) {
  const { isStatusResolved } = useVPN();
  return useQuery({
    queryKey: ['geolocation', connectionStatus],
    queryFn: async (): Promise<GeoLocation> => {
      try {
        // Try Electron IPC path first
        if (window.electronAPI?.getGeolocation) {
          return await window.electronAPI.getGeolocation();
        }

        // Fallback: fetch from ipify + ipapi
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        const ipv4 = ipData.ip;

        const geoResponse = await fetch(`https://ipapi.co/${ipv4}/json/`);
        const geoData = await geoResponse.json();

        return {
          ip: ipv4,
          city: geoData.city,
          region: geoData.region,
          country: geoData.country_name,
        };
      } catch {
        return {
          ip: 'Redacted',
          city: 'Redacted',
          region: '',
          country: 'US',
        };
      }
    },
    // Only look up the real IP/location while genuinely disconnected. When connected, the exit IP
    // comes from the backend's /vpn/connect response instead of a lookup through the tunnel, and
    // until the first tunnel-status read lands the app may have been relaunched with the tunnel
    // already up, so a lookup then would hand the exit IP to a third party.
    enabled: isStatusResolved && connectionStatus === 'disconnected',
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
