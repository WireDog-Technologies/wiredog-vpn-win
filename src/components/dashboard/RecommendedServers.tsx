import React from 'react';
import { Star, Signal, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useServersWithLatency } from '@/hooks/useServers';
import { useVPN } from '@/context/VPNContext';
import { ServerLocation } from '@/types/vpn';
import { cn } from '@/lib/utils';

const RecommendedServers: React.FC = () => {
  const { connect, connection } = useVPN();
  const { data: allServers = [] } = useServersWithLatency();
  const recommendedServers = allServers.filter(s => s.recommended);

  const getLatencyColor = (latency: number) => {
    if (latency < 20) return 'text-connection-active';
    if (latency < 40) return 'text-patriot-gold';
    return 'text-accent';
  };

  const handleConnect = async (server: ServerLocation) => {
    await connect(server);
  };

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Star className="w-4 h-4 text-patriot-gold fill-patriot-gold" />
        <h3 className="font-display text-lg tracking-wide text-foreground">RECOMMENDED SERVERS</h3>
      </div>
      
      <div className="space-y-2">
        {recommendedServers.slice(0, 4).map((server) => {
          const isConnected = connection.server?.id === server.id && connection.status === 'connected';
          const isConnecting = connection.server?.id === server.id && connection.status === 'connecting';
          
          return (
            <div
              key={server.id}
              className={cn(
                "flex items-center justify-between p-3 rounded-lg transition-all",
                "hover:bg-muted/50",
                isConnected && "bg-connection-active/10 border border-connection-active/30"
              )}
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-muted flex items-center justify-center text-xs font-bold">
                  {server.stateCode}
                </div>
                <div>
                  <p className="text-sm font-medium">{server.city}</p>
                  <p className="text-xs text-muted-foreground">{server.state}</p>
                </div>
              </div>
              
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1">
                  <Signal className={cn("w-3 h-3", getLatencyColor(server.latency))} />
                  <span className={cn("text-xs font-mono", getLatencyColor(server.latency))}>
                    {server.latency}ms
                  </span>
                </div>
                
                {isConnected ? (
                  <span className="text-xs text-connection-active font-medium px-2 py-1 bg-connection-active/10 rounded">
                    Connected
                  </span>
                ) : isConnecting ? (
                  <Loader2 className="w-4 h-4 animate-spin text-connection-connecting" />
                ) : (
                  <Button
                    size="sm"
                    variant="patriot"
                    onClick={() => handleConnect(server)}
                    disabled={connection.status === 'connecting'}
                  >
                    Connect
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

export default RecommendedServers;
