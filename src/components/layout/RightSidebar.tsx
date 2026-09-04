import React, { useState, useEffect } from 'react';
import { Loader2, Shield, ShieldOff, Power, Split, ShieldCheck, X } from 'lucide-react';
import { SiWireguard, SiOpenvpn } from 'react-icons/si';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useVPN } from '@/context/VPNContext';
import { useElectron } from '@/context/ElectronContext';
import { useGeolocation } from '@/hooks/useGeolocation';
import { useRecommendedServers } from '@/hooks/useServers';
import { cn } from '@/lib/utils';
import ReconnectDialog from '@/components/ReconnectDialog';
import DisconnectDialog from '@/components/DisconnectDialog';
import Logo from "../../assets/logos/wiredog-minimal-navy_1024x1024.png";
import TextLogo from "../../assets/logos/wiredog_text_logo_1024.png";

const RightSidebar: React.FC = () => {
  const { connection, connect, cancelConnect, disconnect, reconnect, settings, updateSettings, selectedServer, advancedKillSwitchActive, isSubscriptionActive, isSwitchingServer } = useVPN();
  const [showReconnectDialog, setShowReconnectDialog] = useState(false);
  const [showGuardianReconnectDialog, setShowGuardianReconnectDialog] = useState(false);
  const [guardianReconnectMessage, setGuardianReconnectMessage] = useState('');
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const { getAppVersion } = useElectron();
  const { data: geo, isFetching: isGeoFetching } = useGeolocation(connection.status);
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    getAppVersion().then(v => setAppVersion(v)).catch(() => {});
  }, [getAppVersion]);
  const { data: recommendedServers = [] } = useRecommendedServers();
  const defaultServer = recommendedServers[0];

  const isConnected = connection.status === 'connected' && !isSwitchingServer;
  // Includes isSwitchingServer so the brief disconnect->connect gap mid-switch (which
  // connection.status genuinely passes through as 'disconnected') doesn't flicker the UI
  // back to an idle/connectable state.
  const isConnecting = connection.status === 'connecting' || isSwitchingServer;
  const isError = connection.status === 'error';
  // Covers connecting, disconnecting, and reconnecting, plus the brief window right after a
  // transition where the geolocation query is still refetching — shows "Loading..." instead
  // of briefly displaying stale or misleading location/IP left over from before the transition.
  const isTransitioning = isConnecting || (!isConnected && !isError && isGeoFetching);
  // "On" only when both filters are enabled — matches the quick-toggle's all-or-nothing click
  // behavior. An individually-mixed state (e.g. ads on, malware off) still reads as "off" here;
  // use Settings > Guardian Mode for that combination.
  const guardianModeOn = (settings.blockAdsEnabled ?? true) && (settings.blockMalwareEnabled ?? true);

  const [sessionDuration, setSessionDuration] = useState('00:00:00');

  const protocols = [
    { value: 'wireguard', label: 'WireGuard', icon: SiWireguard },
    { value: 'openvpn-udp', label: 'OpenVPN (UDP)', icon: SiOpenvpn },
    { value: 'openvpn-tcp', label: 'OpenVPN (TCP)', icon: SiOpenvpn },
  ];

  useEffect(() => {
    if (isConnected && connection.sessionStart) {
      const interval = setInterval(() => {
        const now = new Date();
        const diff = now.getTime() - connection.sessionStart!.getTime();
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        const seconds = Math.floor((diff % 60000) / 1000);
        setSessionDuration(
          `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
        );
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setSessionDuration('00:00:00');
    }
  }, [isConnected, connection.sessionStart]);

  const handleConnect = async () => {
    if (isConnecting) {
      await cancelConnect();
      return;
    }
    if (isError) {
      // Connection lost — disconnect to clean up, then user can reconnect
      await disconnect();
      return;
    }
    if (isConnected) {
      // If advanced kill switch is enabled, show dialog with options
      if (settings.permanentKillSwitch) {
        setShowDisconnectDialog(true);
        return;
      }
      await disconnect();
    } else {
      const serverToConnect = selectedServer || defaultServer;
      if (serverToConnect) {
        await connect(serverToConnect);
      }
    }
  };

  return (
    <aside className="w-72 h-[calc(100%-16px)] bg-sidebar border border-border flex flex-col m-2 rounded-xl overflow-hidden relative z-20 flex-shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-border flex items-center justify-center flex-shrink-0 gap-2">
        <div className="w-12 h-12 rounded flex items-center justify-center">
            <img
              src={Logo}
              alt="WireDog VPN Logo"
              className="w-12 h-12 object-contain"
            />
        </div>
          <img
            src={TextLogo}
            alt="WireDog"
            className="h-12 w-auto"
          />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col px-4 py-4 overflow-hidden">
        {/* Location & IP Section */}
        <div className="mb-10 flex gap-4">
          {/* Location */}
          <div className="flex-1">
            <p className="text-xs text-muted-foreground">Your Location</p>
            <p className={cn(
              "text-sm font-iosevka font-semibold whitespace-nowrap",
              isError ? "text-red-500" : isConnected ? "text-connection-active" : "text-accent"
            )}>
              {isTransitioning
                ? 'Loading...'
                : isError
                ? `${connection.server?.city || '—'}, ${connection.server?.stateCode || '—'}`
                : isConnected
                ? `${connection.server?.city}, ${connection.server?.stateCode}`
                : (geo?.city ? `${geo.city}, ${geo.region}` : 'Redacted')}
            </p>
          </div>

          {/* IP Address */}
          <div className="flex-1 text-right">
            <p className="text-xs text-muted-foreground">IP Address</p>
            <p className={cn(
              "text-sm font-iosevka font-semibold",
              isError ? "text-red-500" : isConnected ? "text-connection-active" : "text-accent"
            )}>
              {isTransitioning ? 'Loading...' : isError ? '—' : isConnected ? (connection.ipAddress || 'Redacted') : (geo?.ip || 'Redacted')}
            </p>
          </div>
        </div>

        {/* Large Circular Button */}
        <div className="flex justify-center mb-4">
          <button
            onClick={handleConnect}
            disabled={!isConnecting && !isConnected && !isSubscriptionActive}
            title={isConnecting ? 'Cancel connecting' : undefined}
            className={cn(
              "relative w-28 h-28 rounded-full flex items-center justify-center transition-all duration-300 group",
              "border-4",
              isConnected && "border-connection-active bg-connection-active/10 glow-effect-green",
              isConnecting && "border-connection-connecting bg-connection-connecting/10 glow-effect-gold cursor-pointer",
              isError && "border-red-500 bg-red-500/10",
              !isConnected && !isConnecting && !isError && isSubscriptionActive && "border-accent bg-accent/10 hover:bg-accent/20",
              !isConnected && !isConnecting && !isError && !isSubscriptionActive && "border-border bg-muted/20 cursor-not-allowed"
            )}
          >
            <div className={cn(
              "w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300",
              isConnected && "bg-connection-active",
              isConnecting && "bg-connection-connecting connection-pulse",
              isError && "bg-red-500 connection-pulse",
              !isConnected && !isConnecting && !isError && "bg-accent hover:bg-accent/90"
            )}>
              {isConnecting ? (
                <>
                  <Loader2 className="w-8 h-8 text-background animate-spin group-hover:hidden" />
                  <X className="w-8 h-8 text-background hidden group-hover:block" />
                </>
              ) : isConnected ? (
                <Shield className="w-8 h-8 text-background" />
              ) : isError ? (
                <ShieldOff className="w-8 h-8 text-background" />
              ) : (
                <ShieldOff className="w-8 h-8 text-background" />
              )}
            </div>
          </button>
        </div>

        {/* Status Label */}
        <p className={cn(
          "text-center text-sm font-bold mb-2 leading-tight",
          isConnected && "text-connection-active",
          isConnecting && "text-connection-connecting",
          isError && "text-red-500",
          !isConnected && !isConnecting && !isError && advancedKillSwitchActive && "text-amber-500",
          !isConnected && !isConnecting && !isError && !advancedKillSwitchActive && isSubscriptionActive && "text-accent",
          !isConnected && !isConnecting && !isError && !isSubscriptionActive && "text-accent"
        )}>
          {isError ? "CONNECTION LOST" : isConnected ? "PROTECTED" : isConnecting ? "CONNECTING..." : advancedKillSwitchActive ? "PROTECTED (NO VPN)" : !isSubscriptionActive ? <>NO ACTIVE<br />SUBSCRIPTION</> : "UNPROTECTED"}
        </p>

        {/* Divider 2 */}
        <div className="h-px mb-4" />

        {/* Connection Stats Card - Only when connected */}
        {isConnected && (
          <div className="mb-2">
            {/* Top Row: Timer and Label */}
            <div className="flex justify-between items-center mb-2">
              <p className="text-2xl font-iosevka font-medium text-connection-active">
                {sessionDuration}
              </p>
              <p className="text-sm text-muted-foreground">Connection Time</p>
            </div>

            {/* Bottom Row: Server Load and Latency */}
            <div className="flex justify-between items-center">
              {/* Server Load Circle */}
              <div className="flex items-center gap-2">
                <div className="relative w-10 h-10 flex-shrink-0">
                  <svg className="w-full h-full" viewBox="0 0 60 60">
                    {/* Background circle */}
                    <circle cx="30" cy="30" r="24" fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />
                    {/* Progress circle */}
                    <circle
                      cx="30"
                      cy="30"
                      r="24"
                      fill="none"
                      stroke="hsl(var(--connection-active))"
                      strokeWidth="1.5"
                      strokeDasharray={`${(connection.server?.load || 45) * 1.51} 150.8`}
                      strokeLinecap="round"
                      transform="rotate(-90 30 30)"
                    />
                  </svg>
                </div>
                <p className="text-sm font-iosevka font-semibold text-connection-active">
                  {connection.server?.load || 45}%
                </p>
              </div>

              {/* Latency */}
              <p className="text-sm font-iosevka font-semibold text-connection-active">
                {connection.server?.latency}ms Latency
              </p>
            </div>
          </div>
        )}

        {/* Protocol Selector */}
        <div className="mb-2">
          <p className="text-md font-semibold text-muted-foreground mb-2">Protocol</p>
          <Select value={settings.protocol} onValueChange={(value) => updateSettings({ protocol: value as any })}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select protocol" />
            </SelectTrigger>
            <SelectContent>
              {protocols.map((proto) => {
                const Icon = proto.icon;
                const isDisabled = proto.value === 'openvpn-udp' || proto.value === 'openvpn-tcp';
                return (
                  <SelectItem
                    key={proto.value}
                    value={proto.value}
                    disabled={isDisabled}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="text-lg text-muted-foreground" />
                      <span>{proto.label}</span>
                      {isDisabled && <span className="text-xs text-muted-foreground">(Coming Soon)</span>}
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        {/* VPN Features */}
        <div className="flex flex-col gap-2">
          {/* Kill Switch */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => updateSettings({ killSwitch: !settings.killSwitch })}
                  disabled={isConnecting}
                  className={cn(
                    "flex items-center justify-center gap-2 w-full py-3 rounded-lg border transition-all duration-200",
                    isConnecting && "opacity-50 cursor-not-allowed",
                    settings.killSwitch
                      ? "bg-connection-active/20 border-connection-active text-connection-active"
                      : "bg-muted/30 border-border text-muted-foreground hover:bg-muted/50"
                  )}
                >
                  <Power className="w-7 h-7" />
                  <span className="text-xs font-medium">Kill Switch</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Blocks internet if VPN disconnects unexpectedly</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Split Tunneling - Coming Soon */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  disabled
                  className={cn(
                    "relative flex items-center justify-center gap-2 w-full py-3 rounded-lg border transition-all duration-200 opacity-50 cursor-not-allowed",
                    "bg-muted/30 border-border text-muted-foreground"
                  )}
                >
                  <Split className="w-7 h-7" />
                  <span className="text-xs font-medium">Split Tunnel</span>
                  <span className="absolute top-1 right-1.5 text-[9px] font-bold text-muted-foreground/60 tracking-wider">SOON</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Split tunneling coming soon</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Guardian Mode — quick toggle for both DNS filters together; see
              /settings/guardian-mode for independent Block Ads / Block Malware control. */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    const newValue = !guardianModeOn;
                    updateSettings({ blockAdsEnabled: newValue, blockMalwareEnabled: newValue });
                    if (isConnected) {
                      setGuardianReconnectMessage(
                        newValue
                          ? 'Guardian Mode has been enabled. Reconnect now to apply it immediately, or it will apply on your next connection.'
                          : 'Guardian Mode has been disabled. Reconnect now to apply it immediately, or it will apply on your next connection.'
                      );
                      setShowGuardianReconnectDialog(true);
                    }
                  }}
                  disabled={isConnecting}
                  className={cn(
                    "flex items-center justify-center gap-2 w-full py-3 rounded-lg border transition-all duration-200",
                    isConnecting && "opacity-50 cursor-not-allowed",
                    guardianModeOn
                      ? "bg-connection-active/20 border-connection-active text-connection-active"
                      : "bg-muted/30 border-border text-muted-foreground hover:bg-muted/50"
                  )}
                >
                  <ShieldCheck className="w-7 h-7" />
                  <span className="text-xs font-medium">Guardian Mode</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Block ads and malware at the DNS level — tap to toggle both, or open Settings for individual control</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Version Footer */}
      <div className="border-sidebar-border px-4 py-2 flex-shrink-0">
        <p className="text-xs text-muted-foreground text-center">v{appVersion || '...'}</p>
      </div>

      <ReconnectDialog
        open={showReconnectDialog}
        onReconnect={() => {
          setShowReconnectDialog(false);
          reconnect();
        }}
        onDismiss={() => setShowReconnectDialog(false)}
      />

      <ReconnectDialog
        open={showGuardianReconnectDialog}
        message={guardianReconnectMessage}
        onReconnect={() => { setShowGuardianReconnectDialog(false); reconnect(); }}
        onDismiss={() => setShowGuardianReconnectDialog(false)}
      />

      <DisconnectDialog
        open={showDisconnectDialog}
        onDisconnect={() => {
          setShowDisconnectDialog(false);
          disconnect({ disableProtection: false }); // Keep persistent protection
        }}
        onDisconnectAndDisable={() => {
          setShowDisconnectDialog(false);
          disconnect({ disableProtection: true }); // Remove all protection
        }}
        onCancel={() => setShowDisconnectDialog(false)}
      />
    </aside>
  );
};

export default RightSidebar;
