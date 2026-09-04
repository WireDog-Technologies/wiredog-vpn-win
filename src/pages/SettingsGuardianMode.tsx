import React, { useState } from 'react';
import { ChevronLeft, ShieldCheck, ShieldBan } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import ReconnectDialog from '@/components/ReconnectDialog';

const SettingsGuardianMode: React.FC = () => {
  const navigate = useNavigate();
  const { settings, updateSettings, connection, reconnect } = useVPN();
  const [showReconnectDialog, setShowReconnectDialog] = useState(false);
  const [reconnectMessage, setReconnectMessage] = useState('');
  const isConnected = connection.status === 'connected';

  // DNS filtering is resolved to a fixed listener address server-side at connect time (see
  // resolveDnsAddresses in the backend), so a change while connected only takes effect on
  // the next connection.
  const promptReconnectIfNeeded = (label: string, enabled: boolean) => {
    if (!isConnected) return;
    setReconnectMessage(
      `${label} has been ${enabled ? 'enabled' : 'disabled'}. Reconnect now to apply it immediately, or it will apply on your next connection.`
    );
    setShowReconnectDialog(true);
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
            GUARDIAN MODE
          </h1>
          <p className="text-muted-foreground">
            DNS-level ad and malware blocking, applied at the server
          </p>
        </div>

        {/* Block Ads Card */}
        <Card className="p-4 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <ShieldBan className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium leading-tight">Block Ads</p>
                <p className="text-sm text-muted-foreground leading-tight">Block ad and tracker domains</p>
              </div>
            </div>
            <Switch
              checked={settings.blockAdsEnabled ?? true}
              onCheckedChange={(checked) => {
                updateSettings({ blockAdsEnabled: checked });
                promptReconnectIfNeeded('Block Ads', checked);
              }}
            />
          </div>
        </Card>

        {/* Block Malware Card */}
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <ShieldCheck className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium leading-tight">Block Malware</p>
                <p className="text-sm text-muted-foreground leading-tight">Block known malware and phishing domains</p>
              </div>
            </div>
            <Switch
              checked={settings.blockMalwareEnabled ?? true}
              onCheckedChange={(checked) => {
                updateSettings({ blockMalwareEnabled: checked });
                promptReconnectIfNeeded('Block Malware', checked);
              }}
            />
          </div>
        </Card>
      </div>

      <ReconnectDialog
        open={showReconnectDialog}
        message={reconnectMessage}
        onReconnect={() => {
          setShowReconnectDialog(false);
          reconnect();
        }}
        onDismiss={() => setShowReconnectDialog(false)}
      />
    </div>
  );
};

export default SettingsGuardianMode;
