import React from 'react';
import { ChevronLeft, Globe, GlobeLock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';

const SettingsIPv6: React.FC = () => {
  const navigate = useNavigate();
  const { settings, updateSettings } = useVPN();

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
            IPv6 CONNECTIONS
          </h1>
          <p className="text-muted-foreground">
            Configure IPv6 and leak protection settings
          </p>
        </div>

        {/* Description Card */}
        <Card className="p-4 mb-4 bg-muted/50">
          <div className="space-y-2">
            <p className="font-medium text-foreground">What is IPv6?</p>
            <p className="text-sm text-muted-foreground leading-snug">
              IPv6 is the newest version of Internet Protocol, which assigns a unique address to every device on the internet. It was created because the older system (IPv4) is running out of available addresses. Think of it like phone numbers — IPv6 gives us far more numbers so every device can have its own.
            </p>
            <p className="text-sm text-muted-foreground leading-snug">
              When IPv6 is enabled, your VPN will handle both IPv4 and IPv6 traffic. If your internet provider supports IPv6, this ensures all your traffic is routed through the VPN. Leak protection prevents your real IPv6 address from being exposed outside the VPN tunnel.
            </p>
          </div>
        </Card>

        {/* IPv6 Connections Card */}
        <Card className="p-4 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <Globe className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium leading-tight">IPv6 Connections</p>
                <p className="text-sm text-muted-foreground leading-tight">Allow IPv6 traffic over the VPN</p>
              </div>
            </div>
            <Switch
              checked={settings.ipv6Enabled ?? false}
              onCheckedChange={(checked) => updateSettings({ ipv6Enabled: checked })}
            />
          </div>
        </Card>

        {/* IPv6 Leak Protection Card */}
        <Card className={`p-4 transition-opacity ${!(settings.ipv6Enabled ?? false) ? 'opacity-50 pointer-events-none' : ''}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <GlobeLock className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium leading-tight">IPv6 Leak Protection</p>
                <p className="text-sm text-muted-foreground leading-tight">Prevent IPv6 address leaks outside the VPN</p>
              </div>
            </div>
            <Switch
              checked={true}
              disabled
            />
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SettingsIPv6;
