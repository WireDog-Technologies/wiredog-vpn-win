import { useState, useEffect, useRef } from 'react';
import { ServerLocation } from '@/types/vpn';
import { useVPN } from '@/context/VPNContext';

const POLL_INTERVAL_MS = 60_000;
const JITTER_MS = 10_000;

function jitteredInterval() {
  return POLL_INTERVAL_MS + (Math.random() * 2 - 1) * JITTER_MS;
}

// Last good measurements, shared by every consumer of the hook. Probes made with the tunnel up
// are routed through the connected server and come back inflated, so while connected this is the
// last pre-connect snapshot, left untouched. Entries are merged, never replaced wholesale, so a
// pass where some servers didn't answer can't wipe the values already known.
let lastKnownLatency: Record<string, number> = {};

export function useLatency(servers: ServerLocation[]): Record<string, number> {
  const [latencyMap, setLatencyMap] = useState<Record<string, number>>(lastKnownLatency);
  const { connection, isStatusResolved } = useVPN();
  const serversRef = useRef(servers);
  serversRef.current = servers;

  // Only a genuinely disconnected tunnel can be measured. 'connecting' and 'error' (a dropped
  // tunnel being re-established) both route traffic through, or toward, a server.
  const canMeasure = isStatusResolved && connection.status === 'disconnected';

  useEffect(() => {
    if (!window.electronAPI?.measureLatency) return;
    // Connected, connecting or reconnecting: stop probing. Clearing the timer and flipping
    // `cancelled` below also discards any measurement still in flight from before the tunnel came up.
    if (!canMeasure) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function measure() {
      const probeList = serversRef.current
        .filter(s => s.host)
        .map(s => ({ id: s.id, host: s.host }));

      if (probeList.length === 0) return;

      const results = await window.electronAPI!.measureLatency(probeList);
      // A connect may have started mid-measurement; those samples are tunnel-skewed.
      if (cancelled || Object.keys(results).length === 0) return;
      lastKnownLatency = { ...lastKnownLatency, ...results };
      setLatencyMap(lastKnownLatency);
    }

    function scheduleNext() {
      timer = setTimeout(() => {
        measure().then(() => { if (!cancelled) scheduleNext(); });
      }, jitteredInterval());
    }

    // Runs immediately on first mount and again right after a disconnect (this effect re-runs
    // when canMeasure flips back to true), so values refresh once the tunnel is gone.
    measure().then(() => { if (!cancelled) scheduleNext(); });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canMeasure]);

  return latencyMap;
}
