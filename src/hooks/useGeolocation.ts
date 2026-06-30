import { useQuery } from '@tanstack/react-query';

interface GeoLocation {
  ip: string;
  city: string;
  region: string;
  country: string;
}

export function useGeolocation(connectionStatus?: string) {
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
    enabled: connectionStatus !== 'connected',
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
