import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';

// Window.electronAPI's type is declared once, in src/types/vpn.ts (imported wherever needed
// via the ambient `declare global` there) — no separate declaration here to avoid the two
// drifting out of sync with each other and with the real shape electron/preload.js exposes.

interface ElectronContextType {
  // Window controls
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  getAppVersion: () => Promise<string>;
  isWindowMaximized: () => Promise<boolean>;

  // System operations
  openExternal: (url: string) => Promise<boolean>;

  // Settings
  getSettings: () => Promise<Record<string, unknown>>;
  setSettings: (settings: Record<string, unknown>) => Promise<boolean>;

  // System info
  getOsVersion: () => Promise<string>;

  // Logs
  openAppLogs: () => Promise<void>;
  openServiceLogs: () => Promise<void>;

  // Platform info
  platform: string;
  isMac: boolean;
  isWindows: boolean;
  isLinux: boolean;
  isDev: boolean;

  // App state
  isElectron: boolean;
}

const ElectronContext = createContext<ElectronContextType | undefined>(undefined);

// Mock electronAPI for web environment
const mockElectronAPI = {
  minimizeWindow: async () => { console.log('minimizeWindow called (web mode)'); },
  maximizeWindow: async () => { console.log('maximizeWindow called (web mode)'); },
  closeWindow: async () => { console.log('closeWindow called (web mode)'); },
  getAppVersion: async () => '1.0.0-web',
  getOsVersion: async () => 'Web',
  logs: {
    openAppLogs: async () => { console.log('openAppLogs called (web mode)'); },
    openServiceLogs: async () => { console.log('openServiceLogs called (web mode)'); },
  },
  isWindowMaximized: async () => false,
  openExternal: async (url: string) => { window.open(url, '_blank'); return true; },
  getSettings: async () => ({ autoStart: false, killSwitch: true, notifications: true }),
  setSettings: async () => true,
  platform: 'web',
  isMac: false,
  isWindows: false,
  isLinux: false,
  isDev: true
};

export const ElectronProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    // Check if we're running in Electron
    setIsElectron(!!window.electronAPI);
  }, []);

  // Use real electronAPI if available, otherwise use mock. Checked together with isElectron
  // (rather than just isElectron ? window.electronAPI : mock) so TS can narrow
  // window.electronAPI's type here — it can't follow that isElectron implies electronAPI is
  // defined, since that fact was established by a separate state update in the effect above.
  const electronAPI = isElectron && window.electronAPI ? window.electronAPI : mockElectronAPI;

  const value: ElectronContextType = {
    minimizeWindow: electronAPI.minimizeWindow,
    maximizeWindow: electronAPI.maximizeWindow,
    closeWindow: electronAPI.closeWindow,
    getAppVersion: electronAPI.getAppVersion,
    getOsVersion: electronAPI.getOsVersion,
    isWindowMaximized: electronAPI.isWindowMaximized,
    openExternal: electronAPI.openExternal,
    openAppLogs: electronAPI.logs?.openAppLogs || (async () => {}),
    openServiceLogs: electronAPI.logs?.openServiceLogs || (async () => {}),
    getSettings: electronAPI.getSettings,
    setSettings: electronAPI.setSettings,
    platform: electronAPI.platform,
    isMac: electronAPI.isMac,
    isWindows: electronAPI.isWindows,
    isLinux: electronAPI.isLinux,
    isDev: electronAPI.isDev,
    isElectron
  };

  return (
    <ElectronContext.Provider value={value}>
      {children}
    </ElectronContext.Provider>
  );
};

export const useElectron = () => {
  const context = useContext(ElectronContext);
  if (!context) {
    throw new Error('useElectron must be used within an ElectronProvider');
  }
  return context;
};