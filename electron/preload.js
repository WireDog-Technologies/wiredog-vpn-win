const { contextBridge, ipcRenderer } = require('electron');

/**
 * Secure preload script for WireDog VPN
 *
 * This script provides a secure bridge between the main Electron process
 * and the renderer process (React app). It implements context isolation
 * and only exposes safe APIs through the contextBridge.
 *
 * Security principles:
 * - No direct Node.js APIs exposed to renderer
 * - All IPC communication is validated and limited
 * - Context isolation prevents prototype pollution attacks
 */

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('app:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('app:maximize'),
  closeWindow: () => ipcRenderer.invoke('app:close'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getBuildNumber: () => ipcRenderer.invoke('app:get-build-number'),
  isWindowMaximized: () => ipcRenderer.invoke('app:is-maximized'),
  safeReload: () => ipcRenderer.invoke('app:safe-reload'),

  // System info
  getOsVersion: () => ipcRenderer.invoke('system:get-os-version'),
  getGeolocation: () => ipcRenderer.invoke('system:get-geolocation'),

  // System operations
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),

  // Latency measurement
  measureLatency: (servers) => ipcRenderer.invoke('latency:measure-servers', servers),

  // Split tunneling
  getInstalledApps: () => ipcRenderer.invoke('split-tunnel:get-installed-apps'),
  browseForApp: () => ipcRenderer.invoke('split-tunnel:browse-for-app'),

  // VPN operations
  vpn: {
    connect: (serverId, settings) => ipcRenderer.invoke('vpn:connect', { serverId, settings }),
    disconnect: (options) => ipcRenderer.invoke('vpn:disconnect', options),
    getStatus: () => ipcRenderer.invoke('vpn:get-status'),
    getStats: () => ipcRenderer.invoke('vpn:get-stats'),
    toggleKillSwitch: (enabled) => ipcRenderer.invoke('vpn:toggle-killswitch', { enabled }),
    enableAdvancedKillSwitch: () => ipcRenderer.invoke('vpn:enable-advanced-killswitch'),
    disableAdvancedKillSwitch: () => ipcRenderer.invoke('vpn:disable-advanced-killswitch'),
    emergencyReset: () => ipcRenderer.invoke('vpn:emergency-reset'),
    onStatusChange: (callback) => {
      const handler = (_, status) => callback(status);
      ipcRenderer.on('vpn:status-changed', handler);
      return () => ipcRenderer.removeListener('vpn:status-changed', handler);
    }
  },

  // Log operations
  logs: {
    openAppLogs: () => ipcRenderer.invoke('logs:open-app-logs'),
    openServiceLogs: () => ipcRenderer.invoke('logs:open-service-logs'),
  },

  // Compact window operations
  compact: {
    showMain: () => ipcRenderer.invoke('compact:show-main'),
    exit: () => ipcRenderer.invoke('compact:exit'),
  },

  // Event listeners
  on: (channel, callback) => {
    const handler = (_, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return handler;
  },

  off: (channel, handler) => {
    ipcRenderer.removeListener(channel, handler);
  },

  // Legacy VPN operations (for backwards compatibility)
  connectVPN: (serverId) => ipcRenderer.invoke('vpn:connect', { serverId, settings: {} }),
  disconnectVPN: () => ipcRenderer.invoke('vpn:disconnect'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  setAutoLaunch: (enabled, mode) => ipcRenderer.invoke('app:set-auto-launch', { enabled, mode }),

  // Auth token management
  auth: {
    setToken: (token) => ipcRenderer.invoke('auth:set-token', token),
    getToken: () => ipcRenderer.invoke('auth:get-token'),
    clearToken: () => ipcRenderer.invoke('auth:clear-token'),
  },

  // Update operations
  update: {
    signalReady: () => ipcRenderer.invoke('update:renderer-ready'),
    checkForUpdates: () => ipcRenderer.invoke('update:check-now'),
    downloadUpdate: () => ipcRenderer.invoke('update:download-now'),
    installUpdate: () => ipcRenderer.invoke('update:install-now'),
    onAvailable: (callback) => {
      const handler = (_, data) => callback(data);
      ipcRenderer.on('update:available', handler);
      return () => ipcRenderer.removeListener('update:available', handler);
    },
    onDownloaded: (callback) => {
      const handler = (_, data) => callback(data);
      ipcRenderer.on('update:downloaded', handler);
      return () => ipcRenderer.removeListener('update:downloaded', handler);
    },
    onForceRequired: (callback) => {
      const handler = (_, data) => callback(data);
      ipcRenderer.on('update:force-required', handler);
      return () => ipcRenderer.removeListener('update:force-required', handler);
    },
    onMaintenance: (callback) => {
      const handler = (_, data) => callback(data);
      ipcRenderer.on('update:maintenance', handler);
      return () => ipcRenderer.removeListener('update:maintenance', handler);
    },
    onDownloadProgress: (callback) => {
      const handler = (_, data) => callback(data);
      ipcRenderer.on('update:download-progress', handler);
      return () => ipcRenderer.removeListener('update:download-progress', handler);
    },
  },

  // Legacy update listeners (backwards compatibility)
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update:available', callback);
    return () => ipcRenderer.removeListener('update:available', callback);
  },

  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update:downloaded', callback);
    return () => ipcRenderer.removeListener('update:downloaded', callback);
  },

  // Platform detection (safe to expose)
  platform: process.platform,
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  isLinux: process.platform === 'linux',

  // Environment detection
  nodeEnv: process.env.NODE_ENV || 'production',
  isDev: process.env.NODE_ENV === 'development'
});

// Remove any existing global objects that might be unsafe
if (window.electron) {
  delete window.electron;
}

if (window.require) {
  delete window.require;
}

// Prevent prototype pollution
Object.freeze(Object.prototype);
Object.freeze(Array.prototype);
Object.freeze(Function.prototype);

