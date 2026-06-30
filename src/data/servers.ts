import { ServerLocation } from '@/types/vpn';

export const servers: ServerLocation[] = [
  { id: 'ny-1', state: 'New York', stateCode: 'NY', city: 'New York City', latitude: 40.7128, longitude: -74.006, latency: 0, load: 45, recommended: true, host: '' },
  { id: 'ca-1', state: 'California', stateCode: 'CA', city: 'Los Angeles', latitude: 34.0522, longitude: -118.2437, latency: 0, load: 62, host: '' },
  { id: 'ca-2', state: 'California', stateCode: 'CA', city: 'San Francisco', latitude: 37.7749, longitude: -122.4194, latency: 0, load: 38, recommended: true, host: '' },
  { id: 'tx-1', state: 'Texas', stateCode: 'TX', city: 'Dallas', latitude: 32.7767, longitude: -96.797, latency: 0, load: 55, host: '' },
  { id: 'tx-2', state: 'Texas', stateCode: 'TX', city: 'Houston', latitude: 29.7604, longitude: -95.3698, latency: 0, load: 41, host: '' },
  { id: 'fl-1', state: 'Florida', stateCode: 'FL', city: 'Miami', latitude: 25.7617, longitude: -80.1918, latency: 0, load: 68, recommended: true, host: '' },
  { id: 'il-1', state: 'Illinois', stateCode: 'IL', city: 'Chicago', latitude: 41.8781, longitude: -87.6298, latency: 0, load: 52, host: '' },
  { id: 'wa-1', state: 'Washington', stateCode: 'WA', city: 'Seattle', latitude: 47.6062, longitude: -122.3321, latency: 0, load: 33, host: '' },
  { id: 'ga-1', state: 'Georgia', stateCode: 'GA', city: 'Atlanta', latitude: 33.749, longitude: -84.388, latency: 0, load: 47, host: '' },
  { id: 'co-1', state: 'Colorado', stateCode: 'CO', city: 'Denver', latitude: 39.7392, longitude: -104.9903, latency: 0, load: 29, host: '' },
  { id: 'az-1', state: 'Arizona', stateCode: 'AZ', city: 'Phoenix', latitude: 33.4484, longitude: -112.074, latency: 0, load: 36, host: '' },
  { id: 'nv-1', state: 'Nevada', stateCode: 'NV', city: 'Las Vegas', latitude: 36.1699, longitude: -115.1398, latency: 0, load: 44, host: '' },
  { id: 'ma-1', state: 'Massachusetts', stateCode: 'MA', city: 'Boston', latitude: 42.3601, longitude: -71.0589, latency: 0, load: 51, host: '' },
  { id: 'pa-1', state: 'Pennsylvania', stateCode: 'PA', city: 'Philadelphia', latitude: 39.9526, longitude: -75.1652, latency: 0, load: 48, host: '' },
  { id: 'oh-1', state: 'Ohio', stateCode: 'OH', city: 'Columbus', latitude: 39.9612, longitude: -82.9988, latency: 0, load: 35, host: '' },
  { id: 'mi-1', state: 'Michigan', stateCode: 'MI', city: 'Detroit', latitude: 42.3314, longitude: -83.0458, latency: 0, load: 42, host: '' },
  { id: 'nc-1', state: 'North Carolina', stateCode: 'NC', city: 'Charlotte', latitude: 35.2271, longitude: -80.8431, latency: 0, load: 39, host: '' },
  { id: 'or-1', state: 'Oregon', stateCode: 'OR', city: 'Portland', latitude: 45.5152, longitude: -122.6784, latency: 0, load: 31, host: '' },
  { id: 'va-1', state: 'Virginia', stateCode: 'VA', city: 'Richmond', latitude: 37.5407, longitude: -77.436, latency: 0, load: 56, recommended: true, host: '' },
  { id: 'mn-1', state: 'Minnesota', stateCode: 'MN', city: 'Minneapolis', latitude: 44.9778, longitude: -93.265, latency: 0, load: 37, host: '' },
];

export const getServersByState = () => {
  const grouped: Record<string, ServerLocation[]> = {};
  servers.forEach(server => {
    if (!grouped[server.state]) {
      grouped[server.state] = [];
    }
    grouped[server.state].push(server);
  });
  return grouped;
};

export const getRecommendedServers = () => servers.filter(s => s.recommended);

export const getServerById = (id: string) => servers.find(s => s.id === id);
