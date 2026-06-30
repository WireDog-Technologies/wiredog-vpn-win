import React from 'react';
import { ChevronLeft, Monitor } from 'lucide-react';
import { TbPlugConnected } from 'react-icons/tb';
import { useNavigate } from 'react-router-dom';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';
import { useElectronSettings } from '@/hooks/useElectronSettings';

const SettingsConnection: React.FC = () => {
  const navigate = useNavigate();
  const { settings, updateSettings } = useVPN();
  const { settings: electronSettings, updateSettings: updateElectronSettings } = useElectronSettings();

  const isMinimizeToTray = electronSettings.autoStartMode === 'minimize';

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
            CONNECTION
          </h1>
          <p className="text-muted-foreground">
            Configure auto-startup and auto-connect behavior
          </p>
        </div>

        {/* Auto-Startup Card */}
        <Card className="p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <Monitor className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium leading-tight">Auto-Startup</p>
                <p className="text-sm text-muted-foreground leading-tight">Launch app when computer starts</p>
              </div>
            </div>
            <Switch
              checked={electronSettings.autoStart}
              onCheckedChange={(checked) => updateElectronSettings({ autoStart: checked })}
            />
          </div>

          {electronSettings.autoStart && (
            <div className="mt-3 space-y-2">
              {/* Minimize to System Tray Option */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  updateElectronSettings({ autoStartMode: 'minimize' });
                }}
                className={`w-full p-2 rounded-lg border transition-all text-left ${
                  isMinimizeToTray
                    ? 'border-patriot-blue bg-patriot-blue/10'
                    : 'border-border hover:border-muted-foreground'
                }`}
              >
                <p className="font-medium leading-tight">Minimize to System Tray</p>
                <p className="text-sm text-muted-foreground leading-tight">App starts hidden in the system tray</p>
              </button>

              {/* Open to Desktop Option */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  updateElectronSettings({ autoStartMode: 'open' });
                }}
                className={`w-full p-2 rounded-lg border transition-all text-left ${
                  !isMinimizeToTray
                    ? 'border-patriot-blue bg-patriot-blue/10'
                    : 'border-border hover:border-muted-foreground'
                }`}
              >
                <p className="font-medium leading-tight">Open to Desktop</p>
                <p className="text-sm text-muted-foreground leading-tight">App starts and opens on your desktop</p>
              </button>
            </div>
          )}
        </Card>

        {/* Auto-Connect Card */}
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <TbPlugConnected className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium leading-tight">Auto-Connect</p>
                <p className="text-sm text-muted-foreground leading-tight">Automatically connect when app starts</p>
              </div>
            </div>
            <Switch
              checked={settings.autoConnect}
              onCheckedChange={(checked) => updateSettings({ autoConnect: checked })}
            />
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SettingsConnection;