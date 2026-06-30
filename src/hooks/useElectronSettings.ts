import { useElectron } from '@/context/ElectronContext';
import { useState, useEffect } from 'react';

/**
 * Hook for managing application settings with Electron persistence
 */
export const useElectronSettings = () => {
  const { getSettings, setSettings, isElectron } = useElectron();
  const [settings, setSettingsState] = useState({
    autoStart: false,
    autoStartMode: 'open' as 'open' | 'minimize',
    killSwitch: true,
    notifications: true,
    theme: 'system' as 'light' | 'dark' | 'system',
    automaticUpdates: true,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadSettings = async () => {
      if (isElectron) {
        try {
          const electronSettings = await getSettings();
          setSettingsState(prev => ({ ...prev, ...electronSettings }));
        } catch (error) {
          console.error('Failed to load settings from Electron:', error);
        }
      }
      setLoading(false);
    };

    loadSettings();
  }, [isElectron, getSettings]);

  const updateSettings = async (newSettings: Partial<typeof settings>) => {
    const updated = { ...settings, ...newSettings };
    setSettingsState(updated);

    if (isElectron) {
      try {
        // If autoStart changed, call Electron API
        if (newSettings.autoStart !== undefined) {
          const mode = newSettings.autoStartMode || updated.autoStartMode;
          await window.electronAPI.setAutoLaunch(newSettings.autoStart, mode);
        }
        // If only mode changed but autoStart is enabled, update Electron API
        else if (newSettings.autoStartMode !== undefined && updated.autoStart) {
          await window.electronAPI.setAutoLaunch(true, newSettings.autoStartMode);
        }

        await setSettings(updated);
      } catch (error) {
        console.error('Failed to save settings to Electron:', error);
        // Revert on failure
        setSettingsState(settings);
        throw error;
      }
    }

    return updated;
  };

  return {
    settings,
    updateSettings,
    loading,
    isElectron
  };
};