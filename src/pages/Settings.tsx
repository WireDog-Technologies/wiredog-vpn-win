import React, { useState } from 'react';
import { Power, Split, User, Bell, ChevronLeft, Globe, RotateCcw, Download, Loader2, CheckCircle } from 'lucide-react';
import { GiCardExchange } from 'react-icons/gi';
import { TbPlugConnected } from 'react-icons/tb';
import { useNavigate } from 'react-router-dom';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useVPN } from '@/context/VPNContext';
import { useElectronSettings } from '@/hooks/useElectronSettings';
import { useAutoUpdate } from '@/hooks/useAutoUpdate';

const Settings: React.FC = () => {
  const navigate = useNavigate();
  const { settings, updateSettings } = useVPN();
  const { settings: electronSettings, updateSettings: updateElectronSettings } = useElectronSettings();
  const { checkForUpdates, updateStatus } = useAutoUpdate();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [checkResult, setCheckResult] = useState<'idle' | 'checking' | 'up-to-date'>('idle');

  const handleCheckForUpdates = async () => {
    setCheckResult('checking');
    const result = await checkForUpdates();
    if (result?.upToDate) {
      setCheckResult('up-to-date');
      setTimeout(() => setCheckResult('idle'), 3000);
    } else {
      setCheckResult('idle');
    }
  };

  const handleRestoreDefaults = async () => {
    // Reset VPN settings
    updateSettings({
      protocol: 'wireguard',
      killSwitch: false,
      autoConnect: false,
      splitTunneling: { enabled: false, mode: 'exclude', apps: [], ips: [] },
      ipv6Enabled: true,
      ipv6LeakProtection: true,
    });

    // Reset electron settings
    await updateElectronSettings({
      autoStart: false,
      autoStartMode: 'open',
      killSwitch: true,
      notifications: true,
      theme: 'system',
    });

    setShowResetConfirm(false);
  };

  return (
    <div className="h-full p-6 star-pattern overflow-auto">
      {/* Back Button */}
      <button
        onClick={() => navigate('/dashboard')}
        className="text-muted-foreground hover:text-foreground transition-colors mb-4 p-0"
      >
        <ChevronLeft className="w-8 h-8" />
      </button>

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="font-display text-4xl tracking-wider text-foreground mb-2">
            SETTINGS
          </h1>
          <p className="text-muted-foreground">
            Configure your VPN preferences
          </p>
        </div>

        {/* Connection Settings */}
        <Card className="p-4 mb-4">
          <h3 className="font-display text-lg tracking-wide mb-6">CONNECTION</h3>

          <div className="space-y-4">
            {/* Protocol */}
            <button
              onClick={() => navigate('/settings/protocol')}
              className="w-full flex items-center justify-between p-3 -m-3 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <GiCardExchange className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="text-left">
                  <p className="font-medium leading-tight">Protocol</p>
                  <p className="text-sm text-muted-foreground leading-tight">Choose your connection protocol</p>
                </div>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180" />
            </button>

            <Separator />

            {/* Kill Switch */}
            <button
              onClick={() => navigate('/settings/kill-switch')}
              className="w-full flex items-center justify-between p-3 -m-3 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Power className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="text-left">
                  <p className="font-medium leading-tight">Kill Switch</p>
                  <p className="text-sm text-muted-foreground leading-tight">Block all traffic if VPN connection drops</p>
                </div>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180" />
            </button>

            <Separator />

            {/* Auto-Connect & Auto-Startup - Clickable Card */}
            <button
              onClick={() => navigate('/settings/connection')}
              className="w-full flex items-center justify-between p-3 -m-3 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <TbPlugConnected className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="text-left">
                  <p className="font-medium leading-tight">Auto-Startup</p>
                  <p className="text-sm text-muted-foreground leading-tight">Set WireDog to open or connect on startup automatically</p>
                </div>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180" />
            </button>

            <Separator />

            {/* Split Tunneling - Coming Soon */}
            <div className="w-full flex items-center justify-between p-3 -m-3 rounded-lg opacity-50 cursor-not-allowed">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Split className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="text-left">
                  <div className="flex items-center gap-2">
                    <p className="font-medium leading-tight">Split Tunneling</p>
                    <span className="text-xs px-1.5 py-0.5 bg-muted border border-border rounded font-medium text-muted-foreground">Coming Soon</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-tight">Choose which apps use the VPN</p>
                </div>
              </div>
            </div>

            <Separator />

            {/* IPv6 Connections */}
            <button
              onClick={() => navigate('/settings/ipv6')}
              className="w-full flex items-center justify-between p-3 -m-3 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Globe className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="text-left">
                  <p className="font-medium leading-tight">IPv6 Connections</p>
                  <p className="text-sm text-muted-foreground leading-tight">Configure IPv6 and leak protection</p>
                </div>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180" />
            </button>
          </div>
        </Card>

        {/* App Settings */}
        <Card className="p-4 mb-4">
          <h3 className="font-display text-lg tracking-wide mb-3">APPLICATION</h3>

          <div className="space-y-4">
            {/* Account */}
            <button
              onClick={() => navigate('/account')}
              className="w-full flex items-center justify-between p-3 -m-3 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <User className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="text-left">
                  <p className="font-medium leading-tight">Account</p>
                  <p className="text-sm text-muted-foreground leading-tight">Manage your account and subscription</p>
                </div>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180" />
            </button>

            <Separator />

            {/* Notifications */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Bell className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium leading-tight">Notifications</p>
                  <p className="text-sm text-muted-foreground leading-tight">Show connection status notifications</p>
                </div>
              </div>
              <Switch
                checked={electronSettings.notifications}
                onCheckedChange={(checked) => updateElectronSettings({ notifications: checked })}
              />
            </div>

            <Separator />

            {/* Automatic Updates */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <RotateCcw className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium leading-tight">Automatic Updates</p>
                  <p className="text-sm text-muted-foreground leading-tight">Automatically install app updates</p>
                </div>
              </div>
              <Switch
                checked={electronSettings.automaticUpdates}
                onCheckedChange={(checked) => updateElectronSettings({ automaticUpdates: checked })}
              />
            </div>

            <Separator />

            {/* Check for Updates */}
            <button
              onClick={handleCheckForUpdates}
              disabled={checkResult === 'checking'}
              className="w-full flex items-center justify-between p-3 -m-3 rounded-lg hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Download className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="text-left">
                  <p className="font-medium leading-tight">Check for Updates</p>
                  <p className="text-sm text-muted-foreground leading-tight">
                    {checkResult === 'checking' && 'Checking...'}
                    {checkResult === 'up-to-date' && "You're up to date"}
                    {checkResult === 'idle' && 'Manually check for new versions'}
                  </p>
                </div>
              </div>
              {checkResult === 'checking' && <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />}
              {checkResult === 'up-to-date' && <CheckCircle className="w-5 h-5 text-green-500" />}
            </button>
          </div>
        </Card>

        {/* Restore to Default Settings */}
        {showResetConfirm ? (
          <Card className="p-4 mb-4 border-destructive bg-destructive/5">
            <div className="space-y-4">
              <p className="font-medium text-foreground">Restore all settings to defaults?</p>
              <p className="text-sm text-muted-foreground">
                This will reset all VPN and application settings to their original values.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={handleRestoreDefaults}
                  className="flex-1 px-4 py-1 bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 transition-colors font-medium"
                >
                  Confirm Reset
                </button>
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="flex-1 px-4 py-1 bg-muted text-muted-foreground rounded-lg hover:bg-muted/80 transition-colors font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          </Card>
        ) : (
          <button
            onClick={() => setShowResetConfirm(true)}
            className="w-full flex items-center justify-center gap-2 px-6 py-1.5 bg-muted text-muted-foreground rounded-lg hover:bg-muted/80 transition-colors font-medium"
          >
            <RotateCcw className="w-5 h-5" />
            Restore to Default Settings
          </button>
        )}

      </div>
    </div>
  );
};

export default Settings;
