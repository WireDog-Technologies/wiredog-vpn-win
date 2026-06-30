import React from 'react';
import { Loader2, ArrowDown, ArrowUp, Server, Activity, Signal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ServerLocation } from '@/types/vpn';
import { getUSStateFlag } from '@/lib/utils';

// Parse WireGuard byte strings like "1.5 MiB" to bytes
const parseWireGuardBytes = (str: string): number => {
  if (!str) return 0;
  const match = str.match(/([\d.]+)\s*(\w+)/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
  return value * (multipliers[unit] || 1);
};

// Format bytes per second to readable format
const formatSpeed = (bytesPerSecond: number): string => {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
};

// Get unit info for Y-axis
const getAxisUnit = (maxBytes: number): { unit: string; divisor: number } => {
  if (maxBytes < 1024) return { unit: 'B/s', divisor: 1 };
  if (maxBytes < 1024 * 1024) return { unit: 'KB/s', divisor: 1024 };
  return { unit: 'MB/s', divisor: 1024 * 1024 };
};

// Speed graph with gradient area fills
const SpeedGraph: React.FC<{ downloadHistory: number[]; uploadHistory: number[] }> = ({ downloadHistory, uploadHistory }) => {
  const maxVal = Math.max(...downloadHistory, ...uploadHistory, 1);
  const { unit, divisor } = getAxisUnit(maxVal);
  const scaledMax = Math.ceil(maxVal / divisor);

  const height = 44;
  const width = 120;
  const points = downloadHistory.length;

  const getPoints = (history: number[]) =>
    history.map((val, i) => {
      const x = (i / (points - 1 || 1)) * width;
      const y = height - (val / maxVal) * height;
      return `${x},${y}`;
    }).join(' ');

  const getAreaPoints = (history: number[]) => {
    const line = history.map((val, i) => {
      const x = (i / (points - 1 || 1)) * width;
      const y = height - (val / maxVal) * height;
      return `${x},${y}`;
    });
    return `0,${height} ${line.join(' ')} ${width},${height}`;
  };

  return (
    <div className="flex gap-1.5 h-full">
      <div className="flex flex-col justify-between text-[10px] text-muted-foreground/60 font-iosevka text-right w-8 py-0.5">
        <span>{scaledMax}</span>
        <span className="text-[9px]">{unit}</span>
        <span>0</span>
      </div>
      <svg className="flex-1 h-full rounded" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="dlFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--connection-active))" stopOpacity="0.25" />
            <stop offset="100%" stopColor="hsl(var(--connection-active))" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ulFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--patriot-gold))" stopOpacity="0.15" />
            <stop offset="100%" stopColor="hsl(var(--patriot-gold))" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={height * 0.5} x2={width} y2={height * 0.5} stroke="hsl(var(--border))" strokeWidth="0.3" strokeDasharray="2,3" />
        {downloadHistory.length > 1 && <polygon points={getAreaPoints(downloadHistory)} fill="url(#dlFill)" />}
        {uploadHistory.length > 1 && <polygon points={getAreaPoints(uploadHistory)} fill="url(#ulFill)" />}
        {downloadHistory.length > 1 && (
          <polyline points={getPoints(downloadHistory)} fill="none" stroke="hsl(var(--connection-active))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {uploadHistory.length > 1 && (
          <polyline points={getPoints(uploadHistory)} fill="none" stroke="hsl(var(--patriot-gold))" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
        )}
      </svg>
    </div>
  );
};

interface BottomToolbarProps {
  selectedServer: ServerLocation | null;
  isConnected: boolean;
  isConnecting: boolean;
  connectedServer: ServerLocation | null;
  isSubscriptionActive: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  speedData: {
    downloadSpeed: number;
    uploadSpeed: number;
    downloadHistory: number[];
    uploadHistory: number[];
  };
}

const BottomToolbar: React.FC<BottomToolbarProps> = ({
  selectedServer,
  isConnected,
  isConnecting,
  connectedServer,
  isSubscriptionActive,
  onConnect,
  onDisconnect,
  speedData
}) => {
  const displayServer = isConnected ? connectedServer : selectedServer;

  if (!displayServer) {
    return (
      <div className="h-full rounded-xl border border-border/50 bg-background/80 backdrop-blur-xl flex items-center justify-center">
        <p className="text-muted-foreground/50 text-sm tracking-wide">Select a server from the map</p>
      </div>
    );
  }

  return (
    <div className={`h-full rounded-xl border bg-background/85 backdrop-blur-xl flex gap-5 px-5 py-3 ${
      isConnected ? 'border-connection-active/25' : 'border-border/50'
    }`}>

      {/* Left Column — Server + Speeds + Button */}
      <div className="flex flex-col justify-between w-[280px] flex-shrink-0">
        {/* Top row: flag, name, button */}
        <div className="flex items-center gap-3">
          <img
            src={getUSStateFlag(displayServer.stateCode ?? '')}
            alt={displayServer.state ?? 'Unknown'}
            className="w-10 h-7 rounded object-cover ring-1 ring-white/10 flex-shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-tight truncate">{displayServer.city ?? 'Unknown'}</p>
            <p className="text-[11px] text-muted-foreground leading-tight">{displayServer.state ?? 'Unknown'}</p>
          </div>
          {isConnecting ? (
            <Loader2 className="w-4 h-4 animate-spin text-connection-connecting flex-shrink-0" />
          ) : !isSubscriptionActive && !isConnected ? (
            <Button
              variant="outline"
              size="sm"
              disabled
              className="flex-shrink-0 text-xs font-semibold tracking-wide opacity-50 cursor-not-allowed"
            >
              Connect
            </Button>
          ) : (
            <Button
              variant={isConnected ? "default" : "connect"}
              size="sm"
              onClick={isConnected ? onDisconnect : onConnect}
              disabled={isConnecting}
              className={`flex-shrink-0 text-xs font-semibold tracking-wide ${isConnected ? 'bg-accent hover:bg-accent/90 text-accent-foreground' : ''}`}
            >
              {isConnected ? 'Disconnect' : 'Connect'}
            </Button>
          )}
        </div>

        {/* Bottom row: speeds + server meta */}
        <div className="flex items-end justify-between">
          <div className="flex items-center gap-4 font-iosevka">
            <span className="flex items-center gap-1.5 text-sm">
              <ArrowDown className="w-3 h-3 text-connection-active flex-shrink-0" />
              <span className="font-bold tabular-nums w-8 text-right">{formatSpeed(speedData.downloadSpeed).split(' ')[0]}</span>
              <span className="text-[10px] text-muted-foreground/50 w-6">{formatSpeed(speedData.downloadSpeed).split(' ')[1]}</span>
            </span>
            <span className="flex items-center gap-1.5 text-sm">
              <ArrowUp className="w-3 h-3 text-patriot-gold flex-shrink-0" />
              <span className="font-bold tabular-nums w-8 text-right">{formatSpeed(speedData.uploadSpeed).split(' ')[0]}</span>
              <span className="text-[10px] text-muted-foreground/50 w-6">{formatSpeed(speedData.uploadSpeed).split(' ')[1]}</span>
            </span>
          </div>
          <div className="flex flex-col items-end text-[10px] font-iosevka mb-0.5 gap-0.5">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-muted-foreground/40">{displayServer.load ?? '0'}%<Activity className="w-2.5 h-2.5" /></span>
              <span className={`flex items-center gap-1 ${
                (displayServer.latency ?? 0) <= 0 ? 'text-muted-foreground/40' :
                (displayServer.latency ?? 0) <= 80 ? 'text-connection-active' :
                (displayServer.latency ?? 0) <= 150 ? 'text-patriot-gold' : 'text-accent'
              }`}>
                {(displayServer.latency ?? 0) > 0 ? `${displayServer.latency}ms` : '—'}<Signal className="w-2.5 h-2.5" />
              </span>
            </div>
            <span className="flex items-center gap-1 text-muted-foreground/40">{displayServer.id?.toUpperCase() ?? '---'}<Server className="w-2.5 h-2.5" /></span>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="w-px bg-gradient-to-b from-transparent via-border/50 to-transparent" />

      {/* Right Column — Graph */}
      <div className="flex-1 min-w-0">
        <SpeedGraph
          downloadHistory={speedData.downloadHistory}
          uploadHistory={speedData.uploadHistory}
        />
      </div>
    </div>
  );
};

export { parseWireGuardBytes, formatSpeed };
export default BottomToolbar;
