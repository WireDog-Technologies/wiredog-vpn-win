import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { GiCardExchange } from 'react-icons/gi';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import { Protocol } from '@/types/vpn';

const SettingsProtocol: React.FC = () => {
  const navigate = useNavigate();
  const { settings, updateSettings } = useVPN();

  const protocols: { value: Protocol; label: string; description: string; disabled?: boolean }[] = [
    { value: 'wireguard', label: 'WireGuard', description: 'Best Performance with Strong Security - Recommended for Most Users' },
    { value: 'openvpn-udp', label: 'OpenVPN (UDP)', description: 'Faster, Less Stable - Great for Streaming and General Browsing', disabled: true },
    { value: 'openvpn-tcp', label: 'OpenVPN (TCP)', description: 'Slower, More Reliable - Most Compatibile with Strict Networks', disabled: true },
  ];

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
            PROTOCOL
          </h1>
          <p className="text-muted-foreground">
            Choose your VPN connection protocol
          </p>
        </div>

        {/* Protocol Options */}
        <Card className="p-4">
          <div className="space-y-2">
            {protocols.map((proto) => (
              <button
                key={proto.value}
                onClick={() => !proto.disabled && updateSettings({ protocol: proto.value })}
                disabled={proto.disabled}
                className={`w-full p-2.5 rounded-lg border transition-all text-left ${
                  proto.disabled
                    ? 'border-border opacity-50 cursor-not-allowed'
                    : settings.protocol === proto.value
                      ? 'border-patriot-blue bg-patriot-blue/10'
                      : 'border-border hover:border-muted-foreground'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                    <GiCardExchange className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium leading-tight">{proto.label}</p>
                    <p className="text-sm text-muted-foreground leading-tight">{proto.description}</p>
                  </div>
                  {proto.disabled && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      Coming Soon
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SettingsProtocol;
