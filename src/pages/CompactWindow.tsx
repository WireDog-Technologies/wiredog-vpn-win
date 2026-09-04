import React, { useMemo, useEffect, useState } from 'react';
import { useServers } from '@/hooks/useServers';
import { useVPN } from '@/context/VPNContext';
import { useGeolocation } from '@/hooks/useGeolocation';
import { cn, getUSStateFlag } from '@/lib/utils';
import { FaServer } from 'react-icons/fa';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import Logo from '@/assets/logos/wiredog-minimal-navy_1024x1024.png';
import TextLogo from '@/assets/logos/wiredog_text_logo_1024.png';
import { ServerLocation } from '@/types/vpn';
import { Loader2, Shield, ShieldOff, X } from 'lucide-react';

// Type definitions
interface HierarchyCity {
  cityName: string;
  servers: ServerLocation[];
}

interface HierarchyState {
  stateName: string;
  stateCode: string;
  cities: HierarchyCity[];
}

// Build State → City → Server hierarchy from flat server list
const buildHierarchy = (servers: ServerLocation[]): HierarchyState[] => {
  const byState = new Map<string, ServerLocation[]>();
  servers.forEach(server => {
    const stateServers = byState.get(server.state) || [];
    stateServers.push(server);
    byState.set(server.state, stateServers);
  });

  const hierarchy: HierarchyState[] = [];
  byState.forEach((stateServers, stateName) => {
    const byCity = new Map<string, ServerLocation[]>();
    stateServers.forEach(server => {
      const cityServers = byCity.get(server.city) || [];
      cityServers.push(server);
      byCity.set(server.city, cityServers);
    });

    const cities: HierarchyCity[] = Array.from(byCity.entries()).map(([cityName, servers]) => ({
      cityName,
      servers: servers.sort((a, b) => a.id.localeCompare(b.id))
    }));

    hierarchy.push({
      stateName,
      stateCode: stateServers[0].stateCode,
      cities: cities.sort((a, b) => a.cityName.localeCompare(b.cityName))
    });
  });

  return hierarchy.sort((a, b) => a.stateName.localeCompare(b.stateName));
};

const CompactWindow: React.FC = () => {
  const { data: servers = [], isLoading } = useServers();
  const { connection, connect, cancelConnect, selectedServer, setSelectedServer } = useVPN();
  const { data: geo, isFetching: isGeoFetching } = useGeolocation(connection.status);
  const [isConnecting, setIsConnecting] = useState(false);


  // Get initial status on mount
  useEffect(() => {
    const getInitialStatus = async () => {
      try {
        if (window.electronAPI?.vpn?.getStatus) {
          await window.electronAPI.vpn.getStatus();
        }
      } catch (error) {
        console.error('Failed to get initial status:', error);
      }
    };

    getInitialStatus();
  }, []);

  // Build server hierarchy
  const serverHierarchy = useMemo(() => {
    return buildHierarchy(servers);
  }, [servers]);

  // Connection status helpers
  const isConnected = connection.status === 'connected';
  const isConnectingState = connection.status === 'connecting' || isConnecting;

  // Status colors and labels
  const statusColor = isConnected
    ? 'text-connection-active'
    : isConnectingState
      ? 'text-connection-connecting'
      : 'text-accent';

  const statusLabel = isConnected
    ? 'PROTECTED'
    : isConnectingState
      ? 'CONNECTING...'
      : 'UNPROTECTED';

  // Covers connecting/disconnecting/reconnecting plus the brief window right after a
  // transition where the geolocation query is still refetching.
  const isTransitioning = isConnectingState || (!isConnected && isGeoFetching);

  // Location and IP display
  const displayLocation = isTransitioning
    ? 'Loading...'
    : isConnected
      ? connection.server
        ? `${connection.server.city}, ${connection.server.stateCode}`
        : 'Connected'
      : geo?.city ? `${geo.city}, ${geo.region}` : 'Redacted';

  const displayIP = isTransitioning ? 'Loading...' : isConnected ? (connection.ipAddress || 'Redacted') : (geo?.ip || 'Redacted');

  // Handle server connect (from list)
  const handleServerConnect = async (server: ServerLocation) => {
    setIsConnecting(true);
    try {
      setSelectedServer(server);
      await connect(server);
    } catch (error) {
      console.error('Connection failed:', error);
    } finally {
      setIsConnecting(false);
    }
  };

  // Handle main connection toggle button
  const handleConnect = async () => {
    if (isConnectingState) {
      await cancelConnect();
      return;
    }
    if (isConnected) {
      try {
        await window.electronAPI?.vpn?.disconnect?.();
      } catch (error) {
        console.error('Disconnect failed:', error);
      }
    } else {
      const serverToConnect = selectedServer;
      if (serverToConnect) {
        await handleServerConnect(serverToConnect);
      }
    }
  };

  // Handle open main window
  const handleOpenMain = async () => {
    try {
      if (window.electronAPI?.compact?.showMain) {
        await window.electronAPI.compact.showMain();
      }
    } catch (error) {
      console.error('Failed to open main window:', error);
    }
  };

  // Handle exit
  const handleExit = async () => {
    try {
      if (window.electronAPI?.compact?.exit) {
        await window.electronAPI.compact.exit();
      }
    } catch (error) {
      console.error('Failed to exit:', error);
    }
  };

  return (
    <div className="h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white flex flex-col">
      {/* Header - Logos */}
      <div className="px-4 py-3 flex items-center justify-center flex-shrink-0 gap-2 border-b border-slate-700">
        <img src={Logo} alt="WireDog VPN Logo" className="w-8 h-8 object-contain" />
        <img src={TextLogo} alt="WireDog" className="h-8 w-auto" />
      </div>

      {/* Location and IP Section */}
      <div className="px-4 py-3 flex gap-4 border-b border-slate-700 flex-shrink-0">
        {/* Left Column - Location */}
        <div className="flex-1">
          <p className="text-xs text-slate-400">Your Location</p>
          <p className={cn('text-sm font-semibold font-iosevka', isConnected ? 'text-connection-active' : 'text-accent')}>
            {displayLocation}
          </p>
        </div>

        {/* Right Column - IP */}
        <div className="flex-1 text-right">
          <p className="text-xs text-slate-400">IP Address</p>
          <p className={cn('text-sm font-semibold font-iosevka', isConnected ? 'text-connection-active' : 'text-accent')}>
            {displayIP}
          </p>
        </div>
      </div>

      {/* Large Circular Connection Button */}
      <div className="px-4 py-4 flex justify-center flex-shrink-0 border-b border-slate-700">
        <button
          onClick={handleConnect}
          title={isConnectingState ? 'Cancel connecting' : undefined}
          className={cn(
            "relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 group",
            "border-4",
            isConnected && "border-connection-active bg-connection-active/10 glow-effect-green",
            isConnectingState && "border-connection-connecting bg-connection-connecting/10 glow-effect-gold cursor-pointer",
            !isConnected && !isConnectingState && "border-accent bg-accent/10 hover:bg-accent/20"
          )}
        >
          <div className={cn(
            "w-16 h-16 rounded-full flex items-center justify-center transition-all duration-300",
            isConnected && "bg-connection-active",
            isConnectingState && "bg-connection-connecting connection-pulse",
            !isConnected && !isConnectingState && "bg-accent hover:bg-accent/90"
          )}>
            {isConnectingState ? (
              <>
                <Loader2 className="w-6 h-6 text-background animate-spin group-hover:hidden" />
                <X className="w-6 h-6 text-background hidden group-hover:block" />
              </>
            ) : isConnected ? (
              <Shield className="w-6 h-6 text-background" />
            ) : (
              <ShieldOff className="w-6 h-6 text-background" />
            )}
          </div>
        </button>
      </div>

      {/* Status Label */}
      <div className="px-4 py-2 flex-shrink-0 border-b border-slate-700">
        <p className={cn('text-sm font-bold text-center', statusColor)}>{statusLabel}</p>
      </div>

      {/* Scrollable Server List */}
      <div className="flex-1 px-3 py-3 overflow-auto custom-scrollbar min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-slate-400">Loading servers...</p>
          </div>
        ) : serverHierarchy.length > 0 ? (
          <Accordion type="multiple" className="space-y-1">
            {serverHierarchy.map((state) => (
              <AccordionItem
                key={state.stateCode}
                value={state.stateCode}
                className="border-none"
              >
                <AccordionTrigger className="hover:no-underline py-2 px-2 rounded-lg hover:bg-slate-800/50 text-foreground">
                  <div className="flex items-center gap-2">
                    <img
                      src={getUSStateFlag(state.stateCode)}
                      alt={state.stateName}
                      className="w-5 h-3 rounded-sm object-cover flex-shrink-0"
                    />
                    <span className="text-xs font-medium">{state.stateName}</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-0 pt-1 pl-3 space-y-1">
                  {state.cities
                    .flatMap((city) =>
                      city.servers.map((server) => ({ ...server, cityName: city.cityName }))
                    )
                    .map((server) => {
                      const isConnectedServer = connection.server?.id === server.id && isConnected;
                      const isSelectedServer = selectedServer?.id === server.id;

                      return (
                        <button
                          key={server.id}
                          onClick={() => handleServerConnect(server)}
                          disabled={isConnectingState}
                          className={cn(
                            'w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left disabled:opacity-50',
                            isConnectedServer && 'bg-slate-800 border-l-2 border-patriot-red ml-0 pl-[10px]',
                            isSelectedServer && !isConnectedServer && 'bg-slate-800 border-l-2 border-patriot-gold ml-0 pl-[10px]',
                            !isConnectedServer && !isSelectedServer && 'text-slate-300 hover:bg-slate-800/50 hover:text-white'
                          )}
                        >
                          {/* Server Icon */}
                          <FaServer
                            className={cn(
                              'w-3 h-3 flex-shrink-0',
                              isConnectedServer ? 'text-connection-active' : isSelectedServer ? 'text-patriot-gold' : 'text-slate-400'
                            )}
                          />

                          {/* Server ID and City */}
                          <div className="flex-1 min-w-0">
                            <div
                              className={cn(
                                'text-xs font-mono font-semibold truncate',
                                isConnectedServer
                                  ? 'text-connection-active'
                                  : isSelectedServer
                                    ? 'text-patriot-gold'
                                    : 'text-slate-300'
                              )}
                            >
                              {server.id}
                            </div>
                            <div className={cn('text-xs truncate', isConnectedServer ? 'text-slate-300' : 'text-slate-400')}>
                              {server.cityName}
                            </div>
                          </div>

                          {/* Load badge */}
                          <div className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 flex-shrink-0">
                            {server.load}%
                          </div>
                        </button>
                      );
                    })}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        ) : (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-slate-400">No servers available</p>
          </div>
        )}
      </div>

      {/* Bottom Buttons */}
      <div className="px-4 py-3 flex gap-2 flex-shrink-0 border-t border-slate-700">
        <button
          onClick={handleOpenMain}
          className="flex-1 py-2 rounded-lg font-semibold text-sm bg-slate-700 hover:bg-slate-600 text-white transition-all"
        >
          Open WireDog App
        </button>
        <button
          onClick={handleExit}
          className="flex-1 py-2 rounded-lg font-semibold text-sm bg-slate-800 hover:bg-slate-700 text-red-400 hover:text-red-300 transition-all"
        >
          Exit
        </button>
      </div>
    </div>
  );
};

export default CompactWindow;
