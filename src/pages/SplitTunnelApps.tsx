import React, { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, Search, Plus, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import { SplitTunnelApp } from '@/types/vpn';
import { cn } from '@/lib/utils';

const SplitTunnelApps: React.FC = () => {
  const navigate = useNavigate();
  const { settings, updateSettings } = useVPN();
  const splitTunneling = settings.splitTunneling;

  const [installedApps, setInstalledApps] = useState<SplitTunnelApp[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Load installed apps on mount
  useEffect(() => {
    const load = async () => {
      if (window.electronAPI?.getInstalledApps) {
        try {
          const apps = await window.electronAPI.getInstalledApps();
          setInstalledApps(apps);
        } catch (err) {
          console.error('Failed to load installed apps:', err);
        }
      }
      setIsLoading(false);
    };
    load();
  }, []);

  const selectedPaths = useMemo(
    () => new Set(splitTunneling.apps.map(a => a.exePath.toLowerCase())),
    [splitTunneling.apps]
  );

  const isSelected = (app: SplitTunnelApp) => selectedPaths.has(app.exePath.toLowerCase());

  const toggleApp = (app: SplitTunnelApp) => {
    const path = app.exePath.toLowerCase();
    let newApps: SplitTunnelApp[];
    if (selectedPaths.has(path)) {
      newApps = splitTunneling.apps.filter(a => a.exePath.toLowerCase() !== path);
    } else {
      newApps = [...splitTunneling.apps, app];
    }
    updateSettings({
      splitTunneling: { ...splitTunneling, apps: newApps },
    });
  };

  const handleBrowse = async () => {
    if (!window.electronAPI?.browseForApp) return;
    const app = await window.electronAPI.browseForApp();
    if (app && !selectedPaths.has(app.exePath.toLowerCase())) {
      updateSettings({
        splitTunneling: {
          ...splitTunneling,
          apps: [...splitTunneling.apps, app],
        },
      });
    }
  };

  // Filter and sort: selected apps first, then alphabetical
  const filteredApps = useMemo(() => {
    const query = searchQuery.toLowerCase();

    // Merge installed apps with any manually-added selected apps not in the installed list
    const installedPaths = new Set(installedApps.map(a => a.exePath.toLowerCase()));
    const manualApps = splitTunneling.apps.filter(a => !installedPaths.has(a.exePath.toLowerCase()));
    const allApps = [...installedApps, ...manualApps];

    const filtered = query
      ? allApps.filter(a =>
          a.name.toLowerCase().includes(query) ||
          a.exePath.toLowerCase().includes(query)
        )
      : allApps;

    // Sort: selected first, then alphabetical
    return filtered.sort((a, b) => {
      const aSelected = selectedPaths.has(a.exePath.toLowerCase());
      const bSelected = selectedPaths.has(b.exePath.toLowerCase());
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [installedApps, splitTunneling.apps, selectedPaths, searchQuery]);

  return (
    <div className="h-full p-6 star-pattern overflow-auto">
      {/* Back Button */}
      <button
        onClick={() => navigate('/settings/split-tunneling')}
        className="text-muted-foreground hover:text-foreground transition-colors mb-4 p-0"
      >
        <ChevronLeft className="w-8 h-8" />
      </button>

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-4">
          <h1 className="font-display text-4xl tracking-wider text-foreground mb-1">
            APPLICATIONS
          </h1>
          <p className="text-muted-foreground text-sm">
            {splitTunneling.mode === 'exclude'
              ? 'Selected apps will bypass the VPN'
              : 'Only selected apps will use the VPN'
            }
          </p>
        </div>

        {/* Search + Add */}
        <div className="flex gap-2 mb-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search applications..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-muted/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-connection-active"
            />
          </div>
          <button
            onClick={handleBrowse}
            className="flex items-center gap-1 px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Add</span>
          </button>
        </div>

        {/* Selected count */}
        {splitTunneling.apps.length > 0 && (
          <p className="text-xs text-muted-foreground mb-2">
            {splitTunneling.apps.length} app{splitTunneling.apps.length !== 1 ? 's' : ''} selected
          </p>
        )}

        {/* App List */}
        <Card className="p-2 mb-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-sm text-muted-foreground">Loading applications...</p>
            </div>
          ) : filteredApps.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-sm text-muted-foreground">
                {searchQuery ? 'No apps match your search' : 'No applications found'}
              </p>
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto space-y-0.5">
              {filteredApps.map((app) => {
                const selected = isSelected(app);
                return (
                  <button
                    key={app.exePath}
                    onClick={() => toggleApp(app)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-left",
                      selected
                        ? "bg-connection-active/10 border border-connection-active/30"
                        : "hover:bg-muted/50 border border-transparent"
                    )}
                  >
                    {/* Checkbox */}
                    <div className={cn(
                      "w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors",
                      selected
                        ? "bg-connection-active border-connection-active"
                        : "border-muted-foreground"
                    )}>
                      {selected && (
                        <svg className="w-3 h-3 text-background" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>

                    {/* App info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{app.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{app.exePath}</p>
                    </div>

                    {/* Remove button for manually added apps */}
                    {selected && (
                      <X
                        className="w-4 h-4 text-muted-foreground hover:text-foreground flex-shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleApp(app);
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

export default SplitTunnelApps;
