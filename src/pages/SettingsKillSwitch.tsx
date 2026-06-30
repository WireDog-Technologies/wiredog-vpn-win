import React, { useState } from 'react';
import { ChevronLeft, Power, Lock, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';

const SettingsKillSwitch: React.FC = () => {
  const navigate = useNavigate();
  const { settings, updateSettings } = useVPN();
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<{ text: string; success: boolean } | null>(null);

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
            KILL SWITCH
          </h1>
          <p className="text-muted-foreground">
            Protect your privacy with automatic network protection
          </p>
        </div>

        {/* Description Card */}
        <Card className="p-4 mb-4 bg-muted/50">
          <div className="space-y-2">
            <p className="font-medium text-foreground">What is Kill Switch?</p>
            <p className="text-sm text-muted-foreground leading-snug">
              The Kill Switch is a critical security feature that protects your privacy by blocking all internet traffic if your VPN connection drops unexpectedly. This ensures your true IP address and online activity are never exposed through an unprotected connection.
            </p>
            <p className="text-sm text-muted-foreground leading-snug">
              When enabled, if the VPN connection is interrupted, your device's internet access will be cut off until the VPN connection is re-established. This prevents any data leaks that could compromise your privacy.
            </p>
          </div>
        </Card>

        {/* Kill Switch Toggle Card */}
        <Card className="p-4 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <Power className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium leading-tight">Kill Switch Protection</p>
                <p className="text-sm text-muted-foreground leading-tight">
                  {settings.killSwitch ? 'Enabled - Your connection is protected' : 'Disabled - Enable for maximum protection'}
                </p>
              </div>
            </div>
            <Switch
              checked={settings.killSwitch}
              onCheckedChange={(checked) => updateSettings({ killSwitch: checked })}
            />
          </div>
        </Card>

        {/* Always-On Kill Switch Toggle Card */}
        <Card className="p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <Lock className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium leading-tight">Always-On Kill Switch</p>
                <p className="text-sm text-muted-foreground leading-tight">
                  {settings.permanentKillSwitch ? 'Enabled - Blocks internet when not connected' : 'Disabled'}
                </p>
              </div>
            </div>
            <Switch
              checked={settings.permanentKillSwitch}
              disabled={!settings.killSwitch}
              onCheckedChange={(checked) => updateSettings({ permanentKillSwitch: checked })}
            />
          </div>
          <p className="text-xs text-muted-foreground leading-snug">
            Block all internet whenever the VPN is not connected. Protection persists across disconnect and restart. Requires Kill Switch to be enabled.
          </p>
          {settings.permanentKillSwitch && (
            <p className="text-xs text-amber-500 mt-2 leading-snug">
              Internet requires an active VPN connection. Explicitly disable to restore normal internet access.
            </p>
          )}
        </Card>

        {/* Emergency Reset */}
        {window.electronAPI?.vpn && (
          <Card className="p-4 mt-4 border-red-500/30 bg-red-500/5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-red-500/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <p className="font-medium leading-tight text-red-400">Emergency Reset</p>
                <p className="text-sm text-muted-foreground leading-tight">
                  Remove ALL WFP filters and restore internet
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground leading-snug mb-3">
              Removes all WFP filters, disables kill switch, DNS/IPv6 leak protection, and disconnects the VPN. Use only if your internet connection is stuck due to a crash or unexpected error.
            </p>
            {resetMessage && (
              <p className={`text-xs mb-2 ${resetMessage.success ? 'text-green-400' : 'text-red-400'}`}>
                {resetMessage.text}
              </p>
            )}
            <button
              onClick={async () => {
                setResetting(true);
                setResetMessage(null);
                try {
                  await window.electronAPI!.vpn.emergencyReset();
                  setResetMessage({ text: 'Reset complete. All network filters removed.', success: true });
                } catch (err) {
                  setResetMessage({ text: 'Reset failed. Please restart the application.', success: false });
                } finally {
                  setResetting(false);
                }
              }}
              disabled={resetting}
              className="w-full py-2 px-4 rounded-lg border border-red-500/50 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors text-sm font-medium"
            >
              {resetting ? 'Resetting...' : 'Emergency Reset'}
            </button>
          </Card>
        )}
      </div>
    </div>
  );
};

export default SettingsKillSwitch;