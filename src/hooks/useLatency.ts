import { useState, useEffect, useRef } from 'react';
import { ServerLocation } from '@/types/vpn';

const POLL_INTERVAL_MS = 60_000;
const JITTER_MS = 10_000;

function jitteredInterval() {
  return POLL_INTERVAL_MS + (Math.random() * 2 - 1) * JITTER_MS;
}

export function useLatency(servers: ServerLocation[]): Record<string, number> {
  const [latencyMap, setLatencyMap] = useState<Record<string, number>>({});
  const serversRef = useRef(servers);
  serversRef.current = servers;

  useEffect(() => {
    if (!window.electronAPI?.measureLatency) return;

    let cancelled = false;

    async function measure() {
      const probeList = serversRef.current
        .filter(s => s.host)
        .map(s => ({ id: s.id, host: s.host }));

      if (probeList.length === 0) return;

      const results = await window.electronAPI!.measureLatency(probeList);
      if (!cancelled) setLatencyMap(results);
    }

    measure();

    function scheduleNext() {
      const timer = setTimeout(() => {
        measure().then(() => { if (!cancelled) scheduleNext(); });
      }, jitteredInterval());
      return timer;
    }

    const timer = scheduleNext();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return latencyMap;
}
