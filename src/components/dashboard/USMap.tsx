import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useServersWithLatency, useRecommendedServers } from '@/hooks/useServers';
import { getPositionForCity } from '@/data/cityPositions';
import { useVPN } from '@/context/VPNContext';
import { ServerLocation } from '@/types/vpn';
import { cn } from '@/lib/utils';
import { TbTriangleInvertedFilled } from "react-icons/tb";
import mapSvg from '../../../map.svg';
import BottomToolbar, { parseWireGuardBytes } from '@/components/layout/BottomToolbar';
import { getUSStateFlag } from '@/lib/utils';

// SVG aspect ratio (2000x1200 viewBox)
const SVG_ASPECT_RATIO = 2000 / 1200;

const getLatencyColor = (latency: number) => {
  if (latency <= 0) return 'text-muted-foreground';
  if (latency <= 80) return 'text-connection-active';
  if (latency <= 150) return 'text-patriot-gold';
  return 'text-accent';
};

// Group servers by city - returns one representative server per city
const getServersByCity = (serverList: ServerLocation[]): ServerLocation[] => {
  const cityMap = new Map<string, ServerLocation>();
  serverList.forEach(server => {
    if (!cityMap.has(server.city)) {
      cityMap.set(server.city, server);
    }
  });
  return Array.from(cityMap.values());
};

interface ServerNodeProps {
  server: ServerLocation;
  isActive: boolean;
  isConnecting: boolean;
  isSelected?: boolean;
  onSelect: (server: ServerLocation) => void;
}

const ServerNode: React.FC<ServerNodeProps> = ({ server, isActive, isConnecting, isSelected, onSelect }) => {
  const [isHovered, setIsHovered] = useState(false);
  const position = getPositionForCity(server.city);

  // Determine if popover should shift left (for nodes near right edge)
  const isNearRightEdge = position.x > 70;
  const isNearTopEdge = position.y < 20;

  return (
    <div
      className={cn(
        "absolute transform -translate-x-1/2 -translate-y-1/2",
        isHovered ? "z-[100]" : "z-10"
      )}
      style={{ left: `${position.x}%`, top: `${position.y}%` }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {isActive ? (
        // Connected state: Red fill with white border and glow
        <button
          onClick={() => onSelect(server)}
          className="transition-all duration-300 cursor-pointer group"
          style={{
            filter: 'drop-shadow(0 0 6px hsla(var(--patriot-red) / 0.75))',
            color: 'hsl(var(--patriot-red))'
          }}
        >
          <TbTriangleInvertedFilled className="w-5 h-5 transition-transform duration-200 group-hover:scale-125" style={{ stroke: 'hsl(var(--foreground) / .75)', strokeWidth: 1.5 }} />
        </button>
      ) : isConnecting ? (
        // Connecting state: Animated connection color fill with pulse
        <button
          onClick={() => onSelect(server)}
          className="transition-all duration-300 cursor-pointer animate-pulse group"
          style={{
            color: 'hsl(var(--connection-connecting))'
          }}
        >
          <TbTriangleInvertedFilled className="w-5 h-5 transition-transform duration-200 group-hover:scale-125" style={{ stroke: 'hsl(var(--card))', strokeWidth: 1.5 }} />
        </button>
      ) : isSelected ? (
        // Selected state: Card fill with gold border
        <button
          onClick={() => onSelect(server)}
          className="transition-all duration-300 cursor-pointer group"
          style={{
            color: 'hsl(var(--card) / 0.75)'
          }}
        >
          <TbTriangleInvertedFilled className="w-5 h-5 transition-transform duration-200 group-hover:scale-125" style={{ stroke: 'hsl(var(--patriot-gold))', strokeWidth: 1.5 }} />
        </button>
      ) : (
        // Idle state: Card fill with foreground border
        <button
          onClick={() => onSelect(server)}
          className="transition-all duration-300 cursor-pointer group"
          style={{
            color: 'hsl(var(--card) / 0.75)'
          }}
        >
          <TbTriangleInvertedFilled className="w-5 h-5 transition-transform duration-200 group-hover:scale-125" style={{ stroke: 'hsl(var(--foreground) / 0.75)', strokeWidth: 1 }} />
        </button>
      )}

      {isHovered && (
        <div
          className={cn(
            "absolute animate-fade-in-up z-[100]",
            isNearTopEdge ? "top-full mt-2" : "bottom-full mb-2",
            isNearRightEdge ? "right-0" : "left-1/2 -translate-x-1/2"
          )}
        >
          <div className="bg-popover border border-border rounded-lg p-3 shadow-xl min-w-[180px]">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <img
                  src={getUSStateFlag(server.stateCode)}
                  alt={server.state}
                  className="w-12 h-8 rounded-sm object-cover"
                />
                <div>
                  <p className="text-sm font-foreground">{server.city}</p>
                  <p className="text-sm text-muted-foreground">{server.state}</p>
                </div>
              </div>
              <p className={cn('text-xs font-mono font-semibold', getLatencyColor(server.latency))}>
                {server.latency > 0 ? `${server.latency}ms` : '—'}
              </p>
            </div>
          </div>
          <div
            className={cn(
              "absolute -mt-px",
              isNearTopEdge ? "bottom-full rotate-180 mb-0 -mb-px" : "top-full",
              isNearRightEdge ? "right-4" : "left-1/2 -translate-x-1/2"
            )}
          >
            <div className="border-8 border-transparent border-t-popover" />
          </div>
        </div>
      )}
    </div>
  );
};


const USMap: React.FC = () => {
  const { connection, connect, cancelConnect, disconnect, selectedServer, setSelectedServer, selectServer, isSwitchingServer, isSubscriptionActive } = useVPN();
  const { data: servers = [] } = useServersWithLatency();
  const { data: recommendedServers = [] } = useRecommendedServers();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapAreaRef = useRef<HTMLDivElement>(null);
  const [svgBounds, setSvgBounds] = useState({ left: 0, top: 0, width: 0, height: 0 });

  // Speed monitoring state
  const [speedData, setSpeedData] = useState({
    downloadSpeed: 0,
    uploadSpeed: 0,
    downloadHistory: [] as number[],
    uploadHistory: [] as number[],
  });
  const prevBytesRef = useRef({ received: 0, sent: 0 });

  const cityServers = useMemo(() => getServersByCity(servers), [servers]);

  const isConnected = connection.status === 'connected' && !isSwitchingServer;
  // Includes isSwitchingServer so the brief disconnect->connect gap mid-switch (which
  // connection.status genuinely passes through as 'disconnected') doesn't flicker the UI
  // back to an idle/connectable state.
  const isConnecting = connection.status === 'connecting' || isSwitchingServer;

  // Set default server on mount (first recommended server)
  useEffect(() => {
    if (recommendedServers.length > 0 && !selectedServer) {
      setSelectedServer(recommendedServers[0]);
    }
  }, [recommendedServers, selectedServer]);

  // Speed monitoring effect
  useEffect(() => {
    if (!isConnected) {
      // Reset speed data when disconnected
      setSpeedData({
        downloadSpeed: 0,
        uploadSpeed: 0,
        downloadHistory: [],
        uploadHistory: [],
      });
      prevBytesRef.current = { received: 0, sent: 0 };
      return;
    }

    const pollSpeed = async () => {
      try {
        // Try Electron API first
        if (window.electronAPI?.vpn?.getStats) {
          const stats = await window.electronAPI.vpn.getStats();
          if (stats) {
            const received = parseWireGuardBytes(stats.bytesReceived);
            const sent = parseWireGuardBytes(stats.bytesSent);

            // Calculate speed (bytes per second)
            const downloadSpeed = Math.max(0, received - prevBytesRef.current.received);
            const uploadSpeed = Math.max(0, sent - prevBytesRef.current.sent);

            prevBytesRef.current = { received, sent };

            setSpeedData(prev => ({
              downloadSpeed,
              uploadSpeed,
              downloadHistory: [...prev.downloadHistory.slice(-29), downloadSpeed],
              uploadHistory: [...prev.uploadHistory.slice(-29), uploadSpeed],
            }));
            return;
          }
        }

        // Browser fallback: simulate speed data for development
        const downloadSpeed = Math.random() * 2 * 1024 * 1024 + 500 * 1024; // 0.5-2.5 MB/s
        const uploadSpeed = Math.random() * 1 * 1024 * 1024 + 200 * 1024; // 0.2-1.2 MB/s

        setSpeedData(prev => ({
          downloadSpeed,
          uploadSpeed,
          downloadHistory: [...prev.downloadHistory.slice(-29), downloadSpeed],
          uploadHistory: [...prev.uploadHistory.slice(-29), uploadSpeed],
        }));
      } catch (error) {
        console.error('Speed monitoring error:', error);
      }
    };

    // Poll every second
    const interval = setInterval(pollSpeed, 1000);
    pollSpeed(); // Initial poll

    return () => clearInterval(interval);
  }, [isConnected]);

  // Calculate bounds for the map area (excluding right panel and bottom toolbar)
  const updateSvgBounds = useCallback(() => {
    if (!mapAreaRef.current) return;
    const container = mapAreaRef.current;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const containerAspect = containerWidth / containerHeight;

    let width: number, height: number, left: number, top: number;

    if (containerAspect > SVG_ASPECT_RATIO) {
      height = containerHeight;
      width = height * SVG_ASPECT_RATIO;
      left = (containerWidth - width) / 2;
      top = 0;
    } else {
      width = containerWidth;
      height = width / SVG_ASPECT_RATIO;
      left = 0;
      top = (containerHeight - height) / 2;
    }

    setSvgBounds({ left, top, width, height });
  }, []);

  useEffect(() => {
    updateSvgBounds();
    window.addEventListener('resize', updateSvgBounds);
    return () => window.removeEventListener('resize', updateSvgBounds);
  }, [updateSvgBounds]);

  // Handle server selection (clicking on map node) — quick-switches immediately if already
  // connected/connecting to a different server (see VPNContext.selectServer).
  const handleSelect = (server: ServerLocation) => {
    selectServer(server);
  };

  // Handle connect button click
  const handleConnect = async () => {
    if (selectedServer && !isConnecting) {
      await connect(selectedServer);
    }
  };

  // Handle disconnect button click
  const handleDisconnect = async () => {
    await disconnect();
  };

  // Handle cancel button click (shown in place of Connect while connecting/reconnecting)
  const handleCancelConnect = async () => {
    await cancelConnect();
  };

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[400px] bg-card overflow-hidden flex flex-col">
      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Map Area */}
        <div ref={mapAreaRef} className="flex-1 relative min-w-[500px]">
          {/* Background Pattern */}
          <div className="absolute inset-0 star-pattern opacity-100" />

          {/* US Map SVG */}
          <img
            src={mapSvg}
            alt="US Map"
            className="absolute inset-0 w-full h-full object-contain -translate-y-20"
            style={{ filter: 'drop-shadow(0 8px 10px rgba(179, 33, 43, 0.25))' }}
          />

          {/* Server Nodes */}
          <div
            className="absolute -translate-y-20"
            style={{
              left: svgBounds.left,
              top: svgBounds.top,
              width: svgBounds.width,
              height: svgBounds.height,
            }}
          >
            {cityServers.map((server) => (
              <ServerNode
                key={server.city}
                server={server}
                isActive={connection.server?.city === server.city && connection.status === 'connected'}
                isConnecting={connection.server?.city === server.city && connection.status === 'connecting'}
                isSelected={selectedServer?.city === server.city && connection.status !== 'connected'}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Toolbar - Server Selection Toolbar (centered) */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2 z-20 pointer-events-none">
        <div className="w-[750px] h-[135px] flex-shrink-0 pointer-events-auto">
          <BottomToolbar
            selectedServer={selectedServer}
            isConnected={isConnected}
            isConnecting={isConnecting}
            connectedServer={connection.server}
            isSubscriptionActive={isSubscriptionActive}
            onConnect={handleConnect}
            onCancelConnect={handleCancelConnect}
            onDisconnect={handleDisconnect}
            speedData={speedData}
          />
        </div>
      </div>
    </div>
  );
};

export default USMap;
