import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useServersWithLatency } from '@/hooks/useServers';
import { useVPN } from '@/context/VPNContext';
import { cn, getUSStateFlag } from '@/lib/utils';
import { RiAccountBoxFill } from "react-icons/ri";
import { Search, Settings, Star, ArrowUpAZ, Signal, MapPin } from 'lucide-react';
import { FaServer } from "react-icons/fa";
import { Input } from '@/components/ui/input';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { ServerLocation, User } from '@/types/vpn';

// Helper: Load favorites from localStorage
const loadFavorites = (): string[] => {
  try {
    const stored = localStorage.getItem('wiredog:favoriteServers');
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

// Helper: Save favorites to localStorage
const saveFavorites = (favorites: string[]): void => {
  try {
    localStorage.setItem('wiredog:favoriteServers', JSON.stringify(favorites));
  } catch (error) {
    console.error('Failed to save favorites:', error);
  }
};

// Hierarchy data structures
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

// Filter hierarchy by search query (searches states, cities, server IDs)
const filterHierarchy = (
  hierarchy: HierarchyState[],
  query: string
): HierarchyState[] => {
  if (!query.trim()) return hierarchy;

  const lowerQuery = query.toLowerCase();

  return hierarchy
    .map(state => {
      const stateMatches =
        state.stateName.toLowerCase().includes(lowerQuery) ||
        state.stateCode.toLowerCase().includes(lowerQuery);

      const filteredCities = state.cities
        .map(city => {
          const cityMatches = city.cityName.toLowerCase().includes(lowerQuery);
          const filteredServers = city.servers.filter(server =>
            stateMatches || cityMatches || server.id.toLowerCase().includes(lowerQuery)
          );
          return filteredServers.length > 0 ? { ...city, servers: filteredServers } : null;
        })
        .filter(Boolean) as HierarchyCity[];

      return filteredCities.length > 0 ? { ...state, cities: filteredCities } : null;
    })
    .filter(Boolean) as HierarchyState[];
};

// Sort hierarchy (alphabetical or by ping, with favorites priority)
const sortHierarchy = (
  hierarchy: HierarchyState[],
  mode: 'alphabetical' | 'ping',
  favoriteIds: string[]
): HierarchyState[] => {
  const prioritizeFavorites = (servers: ServerLocation[]): ServerLocation[] => {
    const favorites = servers.filter(s => favoriteIds.includes(s.id));
    const nonFavorites = servers.filter(s => !favoriteIds.includes(s.id));
    return [...favorites, ...nonFavorites];
  };

  if (mode === 'alphabetical') {
    return hierarchy.map(state => ({
      ...state,
      cities: state.cities.map(city => ({
        ...city,
        servers: prioritizeFavorites(city.servers)
      }))
    }));
  } else {
    return hierarchy
      .map(state => {
        const citiesWithMinLatency = state.cities.map(city => {
          const sortedServers = [...city.servers].sort((a, b) => a.latency - b.latency);
          const prioritizedServers = prioritizeFavorites(sortedServers);
          return {
            ...city,
            servers: prioritizedServers,
            minLatency: Math.min(...city.servers.map(s => s.latency))
          };
        });

        const sortedCities = citiesWithMinLatency.sort((a, b) => a.minLatency - b.minLatency);

        return {
          ...state,
          cities: sortedCities,
          minLatency: Math.min(...sortedCities.map(c => c.minLatency))
        };
      })
      .sort((a, b) => a.minLatency - b.minLatency);
  }
};

// Helper: Get display name for account
const getAccountDisplayName = (user: User | null): string => {
  if (!user) return 'Not Logged In';
  if (user.isAnonymous) return 'Anonymous';
  return user.username || 'User';
};

const Sidebar: React.FC = () => {
  // Data hooks
  const { data: servers = [] } = useServersWithLatency();
  const { user, connect, connection, selectedServer, setSelectedServer } = useVPN();

  // State management
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortMode, setSortMode] = useState<'alphabetical' | 'ping'>('alphabetical');
  const [favoriteServerIds, setFavoriteServerIds] = useState<string[]>([]);

  // Load favorites from localStorage on mount
  useEffect(() => {
    setFavoriteServerIds(loadFavorites());
  }, []);

  // Toggle favorite status
  const toggleFavorite = useCallback((serverId: string) => {
    setFavoriteServerIds(prev => {
      const newFavorites = prev.includes(serverId)
        ? prev.filter(id => id !== serverId)
        : [...prev, serverId];
      saveFavorites(newFavorites);
      return newFavorites;
    });
  }, []);

  // Handle server click to select
  const handleServerClick = useCallback((server: ServerLocation) => {
    setSelectedServer(server);
  }, [setSelectedServer]);

  // Process servers: build hierarchy, filter and sort
  const processedServers = useMemo(() => {
    const hierarchy = buildHierarchy(servers);
    const filtered = filterHierarchy(hierarchy, searchQuery);
    return sortHierarchy(filtered, sortMode, favoriteServerIds);
  }, [servers, searchQuery, sortMode, favoriteServerIds]);

  const accountName = useMemo(() => getAccountDisplayName(user), [user]);

  // Count states in processed servers
  const statesCount = useMemo(() => {
    return processedServers.length;
  }, [processedServers]);

  return (
    <aside className="w-64 h-[calc(100%-16px)] bg-sidebar border border-sidebar-border flex flex-col m-2 rounded-xl overflow-hidden">
      {/* Account Bar */}
      <div className="px-4 py-4 border-b border-sidebar-border flex items-center gap-2 flex-shrink-0">
        <RiAccountBoxFill className="w-10 h-10 text-muted-foreground flex-shrink-0" />
        <NavLink to="/account" className="flex-1 truncate">
          <span className="text-xl font-medium text-foreground truncate hover:text-patriot-gold transition-colors">
            {accountName}
          </span>
        </NavLink>
        <NavLink to="/settings" className="flex-shrink-0">
          <Settings className="w-6 h-6 text-muted-foreground hover:text-foreground transition-colors cursor-pointer" />
        </NavLink>
      </div>

      {/* Search Field and Filter Toggle */}
      <div className="px-3 py-4 border-b border-sidebar-border flex-shrink-0 flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search Locations"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-8 bg-sidebar-accent/50 border-sidebar-border text-sm"
          />
        </div>
        <button
          onClick={() => setSortMode(prev => prev === 'alphabetical' ? 'ping' : 'alphabetical')}
          className="flex-shrink-0 p-2 rounded-lg bg-sidebar-accent/30 hover:bg-sidebar-accent transition-colors"
          title={sortMode === 'alphabetical' ? 'Sort by: Alphabetical' : 'Sort by: Lowest Ping'}
        >
          {sortMode === 'alphabetical'
            ? <ArrowUpAZ className="w-4 h-4 text-muted-foreground" />
            : <Signal className="w-4 h-4 text-muted-foreground" />
          }
        </button>
      </div>

      {/* Locations Header */}
      <div className="px-4 py-4 flex-shrink-0">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Locations ({statesCount})
        </h2>
      </div>

      {/* Server List */}
      <nav className="flex-1 px-3 space-y-1 overflow-auto custom-scrollbar min-h-0">
        {processedServers.length > 0 ? (
          <Accordion type="multiple" className="space-y-1">
            {processedServers.map((state) => (
              <AccordionItem
                key={state.stateCode}
                value={state.stateCode}
                className="border-none"
              >
                <AccordionTrigger className="hover:no-underline py-2 px-2 rounded-lg hover:bg-sidebar-accent/50 text-foreground">
                  <div className="flex items-center gap-2">
                    <img
                      src={getUSStateFlag(state.stateCode)}
                      alt={state.stateName}
                      className="w-6 h-4 rounded-sm object-cover flex-shrink-0"
                    />
                    <span className="text-sm font-medium">{state.stateName}</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-0 pt-1 pl-3 space-y-1">
                  {state.cities
                    .flatMap((city) =>
                      city.servers.map((server) => ({ ...server, cityName: city.cityName }))
                    )
                    .sort((a, b) => a.id.localeCompare(b.id))
                    .map((server) => {
                      const isConnected = connection.server?.id === server.id && connection.status === 'connected';
                      const isSelected = selectedServer?.id === server.id;
                      const isFav = favoriteServerIds.includes(server.id);

                      return (
                        <button
                          key={server.id}
                          onClick={() => handleServerClick(server)}
                          className={cn(
                            "w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors relative group text-left",
                            isConnected && "bg-sidebar-accent text-foreground font-medium border-l-2 border-patriot-red ml-0 pl-[10px]",
                            isSelected && !isConnected && "bg-sidebar-accent text-foreground font-medium border-l-2 border-patriot-gold ml-0 pl-[10px]",
                            !isConnected && !isSelected && "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                          )}
                        >
                          {/* Server Icon */}
                          <FaServer className={cn(
                            "w-4 h-4 flex-shrink-0",
                            isConnected ? "text-foreground" : isSelected ? "text-patriot-gold" : "text-muted-foreground"
                          )} />

                          {/* Server ID and City */}
                          <div className="flex-1 min-w-0">
                            <div className={cn(
                              "text-sm truncate font-mono",
                              isConnected ? "text-foreground" : isSelected ? "text-patriot-gold" : "text-foreground"
                            )}>{server.id}</div>
                            <div className={cn(
                              "text-xs truncate",
                              isConnected ? "text-foreground" : isSelected ? "text-muted-foreground" : "text-muted-foreground"
                            )}>{server.cityName}</div>
                          </div>

                          {/* Load + Latency badges */}
                          <div className="flex flex-col items-end gap-0.5">
                            <div className="text-xs px-1.5 py-0.5 rounded bg-sidebar-accent/50 text-muted-foreground">
                              {server.load}%
                            </div>
                            <div className={cn(
                              "text-xs px-1.5 py-0.5 rounded bg-sidebar-accent/50 font-mono",
                              server.latency <= 0 ? "text-muted-foreground" :
                              server.latency <= 80 ? "text-connection-active" :
                              server.latency <= 150 ? "text-patriot-gold" : "text-accent"
                            )}>
                              {server.latency > 0 ? `${server.latency}ms` : '—'}
                            </div>
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
            <p className="text-sm text-muted-foreground">No servers found</p>
          </div>
        )}
      </nav>
    </aside>
  );
};

export default Sidebar;
