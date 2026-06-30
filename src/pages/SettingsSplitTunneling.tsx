import React, { useState } from 'react';
import { ChevronLeft, Split, Smartphone, Globe, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import { cn } from '@/lib/utils';
import ReconnectDialog from '@/components/ReconnectDialog';

const SettingsSplitTunneling: React.FC = () => {
  const navigate = useNavigate();
  const { settings, updateSettings, connection, reconnect } = useVPN();
  const splitTunneling = settings.splitTunneling;
  const [showReconnectDialog, setShowReconnectDialog] = useState(false);
  const isConnected = connection.status === 'connected';

  const handleToggle = (enabled: boolean) => {
    updateSettings({
      splitTunneling: { ...splitTunneling, enabled },
    });
    if (isConnected) setShowReconnectDialog(true);
  };

  const handleModeChange = (mode: 'include' | 'exclude') => {
    updateSettings({
      splitTunneling: { ...splitTunneling, mode },
    });
    if (isConnected) setShowReconnectDialog(true);
  };

  return (
    <div className="h-full p-6 star-pattern overflow-auto">
      {/* Back Button */}
      <button
        onClick={() => navigate('/settings')}
        className="text-muted-foreground hover:text-foreground transition-colors mb-4 p-0"
      >
        <ChevronLeft className="w-8 h-8" />
      </button>

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="font-display text-4xl tracking-wider text-foreground mb-2">
            SPLIT TUNNELING
          </h1>
          <p className="text-muted-foreground">
            Choose which apps and IPs use the VPN
          </p>
        </div>

        {/* Description Card */}
        <Card className="p-4 mb-4 bg-muted/50">
          <div className="space-y-2">
            <p className="font-medium text-foreground">What is Split Tunneling?</p>
            <p className="text-sm text-muted-foreground leading-snug">
              Split tunneling lets you choose which applications and IP addresses route through the VPN tunnel and which use your regular internet connection. This is useful for accessing local network resources while staying protected.
            </p>
          </div>
        </Card>

        {/* Enable Toggle */}
        <Card className="p-4 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <Split className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium leading-tight">Split Tunneling</p>
                <p className="text-sm text-muted-foreground leading-tight">
                  {splitTunneling.enabled ? 'Enabled' : 'Disabled'}
                </p>
              </div>
            </div>
            <Switch
              checked={splitTunneling.enabled}
              onCheckedChange={handleToggle}
            />
          </div>
        </Card>

        {/* Mode Selector */}
        <Card className={cn("p-4 mb-4", !splitTunneling.enabled && "opacity-50 pointer-events-none")}>
          <h3 className="font-display text-lg tracking-wide mb-3">MODE</h3>
          <div className="space-y-2">
            <button
              onClick={() => handleModeChange('exclude')}
              className={cn(
                "w-full p-3 rounded-lg border text-left transition-all",
                splitTunneling.mode === 'exclude'
                  ? "border-connection-active bg-connection-active/10"
                  : "border-border hover:bg-muted/50"
              )}
            >
              <p className="font-medium text-sm">Exclude</p>
              <p className="text-xs text-muted-foreground">
                Selected apps and IPs bypass the VPN. Everything else is protected.
              </p>
            </button>
            <button
              onClick={() => handleModeChange('include')}
              className={cn(
                "w-full p-3 rounded-lg border text-left transition-all",
                splitTunneling.mode === 'include'
                  ? "border-connection-active bg-connection-active/10"
                  : "border-border hover:bg-muted/50"
              )}
            >
              <p className="font-medium text-sm">Include</p>
              <p className="text-xs text-muted-foreground">
                Only selected apps and IPs use the VPN. Everything else bypasses it.
              </p>
            </button>
          </div>
        </Card>

        {/* Apps & IPs Navigation */}
        <Card className={cn("p-4 mb-4", !splitTunneling.enabled && "opacity-50 pointer-events-none")}>
          <div className="space-y-2">
            {/* Apps */}
            <button
              onClick={() => navigate('/settings/split-tunneling/apps')}
              className="w-full flex items-center justify-between p-3 -mx-1 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Smartphone className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="text-left">
                  <p className="font-medium leading-tight text-sm">Applications</p>
                  <p className="text-xs text-muted-foreground leading-tight">
                    {splitTunneling.apps.length === 0
                      ? 'No apps selected'
                      : `${splitTunneling.apps.length} app${splitTunneling.apps.length !== 1 ? 's' : ''} selected`
                    }
                  </p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-muted-foreground" />
            </button>

            {/* IPs */}
            <button
              onClick={() => navigate('/settings/split-tunneling/ips')}
              className="w-full flex items-center justify-between p-3 -mx-1 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Globe className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="text-left">
                  <p className="font-medium leading-tight text-sm">IP Addresses</p>
                  <p className="text-xs text-muted-foreground leading-tight">
                    {splitTunneling.ips.length === 0
                      ? 'No IPs added'
                      : `${splitTunneling.ips.length} IP${splitTunneling.ips.length !== 1 ? 's' : ''} added`
                    }
                  </p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>
        </Card>
      </div>

      <ReconnectDialog
        open={showReconnectDialog}
        onReconnect={() => {
          setShowReconnectDialog(false);
          reconnect();
        }}
        onDismiss={() => setShowReconnectDialog(false)}
      />
    </div>
  );
};

export default SettingsSplitTunneling;
