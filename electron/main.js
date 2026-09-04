// ================================
// Load environment variables FIRST
// ================================
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { app } = require('electron');
const log = require('electron-log');

// Determine path to .env correctly for dev vs packaged app
const projectRoot = path.join(__dirname, '..');

// A packaged build's baked config lives at resourcesPath/.env — whatever
// `npm run bake-env:production` / `bake-env:integration` copied there before
// electron-builder ran (see package.json and electron-builder.json's extraResources).
// An unpackaged run (`npm run dev`) always defaults to .env.development (integration)
// instead — Vite handles the equivalent split for the renderer bundle automatically via
// its own build-mode env file convention (see build:dev / build:integration in package.json).
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(projectRoot, '.env.development');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true });
  log.info('Loaded environment config from', envPath);
} else if (app.isPackaged) {
  log.warn('No baked environment config found at', envPath, '— falling back to hardcoded production defaults');
} else {
  log.warn('No .env.development found at', envPath, '— falling back to hardcoded production defaults');
}

// Local developer override (gitignored, never shipped) — lets a dev point at a local
// backend instead of integration without touching .env.development. Not consulted in
// packaged builds.
if (!app.isPackaged) {
  const localEnvPath = path.join(projectRoot, '.env.local');
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath, override: true });
    log.info('Loaded local overrides from', localEnvPath);
  }
}

// ================================
// Import Electron and other modules
// ================================
const { BrowserWindow, ipcMain, Menu, Tray, shell, dialog, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const vpnService = require('./vpn');

// Configure logging
log.transports.file.level = 'info';
autoUpdater.logger = log;

// Log environment for debugging
log.info('=== Environment Configuration ===');
log.info('NODE_ENV:', process.env.NODE_ENV);
log.info('VITE_API_URL:', process.env.VITE_API_URL);
log.info('App path:', __dirname);

// Settings store - will be initialized in app.whenReady()
let settingsStore;

// Keep a global reference of the window object
let mainWindow;
let compactWindow;
let tray;

// Application configuration
// In production, NODE_ENV may not be set, so detect by app.isPackaged
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = app.isPackaged ? 'production' : 'development';
}
const isDev = process.env.NODE_ENV === 'development';
const isMac = process.platform === 'darwin';

// Track whether app is quitting to distinguish from minimize-to-tray
let isQuitting = false;

/**
 * Create the main application window
 * Implements secure Electron best practices:
 * - Context isolation enabled
 * - Node integration disabled
 * - Web security enabled
 */
function createMainWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1350,
    minHeight: 800,
    webPreferences: {
      nodeIntegration: false,           // Security: Disable Node.js integration
      contextIsolation: true,           // Security: Enable context isolation
      enableRemoteModule: false,        // Security: Disable remote module
      preload: path.join(__dirname, 'preload.js'), // Secure preload script
      webSecurity: true,                // Security: Enable web security
    },
    icon: path.join(__dirname, '../public/favicon.ico'),
    show: false, // Don't show until ready-to-show
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    frame: false, // Frameless window — custom titlebar handles window controls
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    if (process.argv.includes('--hidden')) {
      log.info('Main window ready but started hidden');
      // Window will remain hidden, tray will be available
    } else {
      mainWindow.show();
      log.info('Main window ready and shown');
    }
  });

  // Handle window close - minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting && !isMac) {
      event.preventDefault();
      mainWindow.hide();
      log.info('Window hidden to tray');
    }
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Retries any /vpn/disconnect calls still owed from a previous launch/session — see
  // VPNService.handleAppForeground / retryPendingDisconnects.
  mainWindow.on('focus', () => {
    vpnService.handleAppForeground();
  });

  // Prevent new window creation
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle renderer process crashes
  mainWindow.webContents.on('render-process-gone', async (event, details) => {
    log.error('Renderer process crashed:', details);
    log.info('Cleaning up VPN connection due to renderer crash');
    try {
      await vpnService.cleanup();
    } catch (error) {
      log.error('VPN cleanup failed after crash:', error);
    }
  });

  // Handle renderer becoming unresponsive
  mainWindow.webContents.on('unresponsive', () => {
    log.warn('Renderer process became unresponsive');
  });

  // Intercept keyboard shortcuts for reload (F5, Ctrl+R)
  mainWindow.webContents.on('before-input-event', async (event, input) => {
    // Detect Ctrl+R or F5 (reload shortcuts)
    const isReload = (input.control && input.key === 'r') || input.key === 'F5';

    if (isReload && input.type === 'keyDown') {
      event.preventDefault();
      log.info('Manual reload detected (F5/Ctrl+R) - cleaning up VPN');
      try {
        await vpnService.cleanup();
      } catch (error) {
        log.error('VPN cleanup failed during reload:', error);
      }
      mainWindow.reload();
    }
  });

  // Set Content Security Policy for additional security
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // In dev mode, also allow the local Vite dev API; omit in production
    const connectSrc = isDev
      ? "connect-src 'self' https: http://localhost:3001; "
      : "connect-src 'self' https:; ";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "img-src 'self' data: https:; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          connectSrc +
          "object-src 'none';"
        ]
      }
    });
  });

  log.info('Main window created');
}

/**
 * Update tray menu with current VPN status
 */
async function updateTrayMenu() {
  if (!tray || isMac) return;

  try {
    // Get current VPN status
    const vpnStatus = await vpnService.getFullStatus();
    const { status, session } = vpnStatus;

    // Update tray icon based on status
    let trayIcon;
    if (status === 'connected') {
      trayIcon = app.isPackaged
        ? path.join(process.resourcesPath, 'favicon-connected.png')
        : path.join(__dirname, '../public/favicon-connected.png');
    } else {
      trayIcon = app.isPackaged
        ? path.join(process.resourcesPath, 'favicon-disconnected.png')
        : path.join(__dirname, '../public/favicon-disconnected.png');
    }
    tray.setImage(trayIcon);

    // Build status label
    let statusLabel = 'Status: Disconnected';
    if (status === 'connecting') {
      statusLabel = 'Status: Connecting...';
    } else if (status === 'connected' && session?.server) {
      const server = session.server;
      const location = server.city ? `${server.city}, ${server.stateCode || ''}` : 'Connected';
      statusLabel = `Status: Connected to ${location}`;
    }

    // Update tooltip
    let tooltip = 'WireDog VPN - Disconnected';
    if (status === 'connecting') {
      tooltip = 'WireDog VPN - Connecting...';
    } else if (status === 'connected' && session?.server) {
      const location = session.server.city
        ? `${session.server.city}, ${session.server.stateCode || ''}`
        : 'Connected';
      tooltip = `WireDog VPN - ${location}`;
    }
    tray.setToolTip(tooltip);

    // Build and set context menu
    const contextMenu = Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: 'separator' },
      { label: 'Show WireDog VPN', click: () => mainWindow.show() },
      { label: 'Hide to Tray', click: () => mainWindow.hide() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]);

    tray.setContextMenu(contextMenu);
  } catch (error) {
    log.error('Failed to update tray menu:', error);
    // Fallback to basic menu on error
    const fallbackMenu = Menu.buildFromTemplate([
      { label: 'Status: Unknown', enabled: false },
      { type: 'separator' },
      { label: 'Show WireDog VPN', click: () => mainWindow.show() },
      { label: 'Hide to Tray', click: () => mainWindow.hide() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(fallbackMenu);
  }
}

/**
 * Create system tray icon
 */
function createTray() {
  if (isMac) return; // macOS handles tray differently

  // In production, favicon is in resources; in dev, it's in public
  const trayIcon = app.isPackaged
    ? path.join(process.resourcesPath, 'favicon.ico')
    : path.join(__dirname, '../public/favicon.ico');
  tray = new Tray(trayIcon);

  // Set initial menu with status
  updateTrayMenu();

  tray.on('click', () => {
    if (compactWindow && compactWindow.isVisible()) {
      compactWindow.hide();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      showCompactWindow();
    }
  });

  log.info('System tray created');
}

/**
 * Create compact window for tray
 */
function createCompactWindow() {
  if (isMac) return; // macOS doesn't need compact window

  // Get screen dimensions to position window in bottom-right
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const windowWidth = 350;
  const windowHeight = 480;
  const x = width - windowWidth - 10; // 10px from right edge
  const y = height - windowHeight - 10; // 10px from bottom (above tray)

  compactWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x,
    y,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
    icon: path.join(__dirname, '../public/favicon.ico'),
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
  });

  // Load the compact window route
  if (isDev) {
    const url = 'http://localhost:5173/#/compact';
    log.info('Loading compact window URL:', url);
    compactWindow.loadURL(url);
  } else {
    const indexPath = path.join(__dirname, '../dist/index.html');
    log.info('Loading compact window from:', indexPath);
    compactWindow.loadFile(indexPath, { hash: 'compact' });
  }

  // Log when content finishes loading
  compactWindow.webContents.on('did-finish-load', () => {
    log.info('Compact window content loaded successfully');
  });

  compactWindow.webContents.on('crashed', () => {
    log.error('Compact window crashed!');
  });

  // Close compact window when user closes it
  compactWindow.on('closed', () => {
    compactWindow = null;
  });

  // Hide compact window when clicking outside (blur)
  compactWindow.on('blur', () => {
    if (compactWindow && !compactWindow.isDestroyed()) {
      compactWindow.hide();
    }
  });

  // Prevent new window creation
  compactWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle renderer process crashes
  compactWindow.webContents.on('render-process-gone', async (event, details) => {
    log.error('Compact window renderer crashed:', details);
    log.info('Cleaning up VPN connection due to compact window crash');
    try {
      await vpnService.cleanup();
    } catch (error) {
      log.error('VPN cleanup failed after crash:', error);
    }
  });

  // Intercept keyboard shortcuts for reload (F5, Ctrl+R) in compact window
  compactWindow.webContents.on('before-input-event', async (event, input) => {
    const isReload = (input.control && input.key === 'r') || input.key === 'F5';

    if (isReload && input.type === 'keyDown') {
      event.preventDefault();
      log.info('Manual reload detected in compact window - cleaning up VPN');
      try {
        await vpnService.cleanup();
      } catch (error) {
        log.error('VPN cleanup failed during reload:', error);
      }
      compactWindow.reload();
    }
  });

  // Set Content Security Policy
  compactWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // In dev mode, also allow the local Vite dev API; omit in production
    const connectSrc = isDev
      ? "connect-src 'self' https: http://localhost:3001; "
      : "connect-src 'self' https:; ";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "img-src 'self' data: https:; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          connectSrc +
          "object-src 'none';"
        ]
      }
    });
  });

  log.info('Compact window created');
}

/**
 * Show compact window and hide main window
 */
function showCompactWindow() {
  if (isMac) return;

  if (!compactWindow) {
    createCompactWindow();
  }

  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.hide();
  }

  compactWindow.show();
  compactWindow.focus();
  log.info('Compact window shown');
}

/**
 * Hide compact window and show main window
 */
function hideCompactWindow() {
  if (!compactWindow || compactWindow.isDestroyed()) return;

  compactWindow.hide();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }

  log.info('Compact window hidden');
}

/**
 * Create application menu (macOS)
 */
function createMenu() {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }

  const template = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * IPC event handlers
 * These handle secure communication from renderer process
 */
function getAuthToken() {
  try {
    const stored = settingsStore.get('authToken');
    if (!stored) return null;
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

function setupIpcHandlers() {
  // Window controls
  ipcMain.handle('app:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('app:maximize', () => {
    if (mainWindow) {
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    }
  });

  ipcMain.handle('app:close', () => {
    if (mainWindow) mainWindow.close();
  });

  ipcMain.handle('app:quit', () => {
    isQuitting = true;
    app.quit();
  });

  ipcMain.handle('app:get-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:get-build-number', () => {
    const pkg = require('../package.json');
    return pkg.buildNumber || 0;
  });

  ipcMain.handle('app:is-maximized', () => {
    return mainWindow ? mainWindow.isMaximized() : false;
  });

  // System operations
  ipcMain.handle('system:open-external', async (event, url) => {
    try {
      // Only allow safe web protocols — reject file:, ms-msdt:, and other custom URI schemes
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        log.warn('system:open-external blocked non-web URL scheme:', parsed.protocol);
        return false;
      }
      await shell.openExternal(url);
      return true;
    } catch (error) {
      log.error('Failed to open external URL:', error);
      return false;
    }
  });

  // VPN operations - Real implementation
  ipcMain.handle('vpn:connect', async (event, { serverId, settings }) => {
    log.info(`VPN connect request: ${serverId}`);

    // Re-check update policy before allowing connection
    log.info('[Update] Pre-connect policy check before VPN connection');
    try {
      const policy = await checkUpdatePolicy();
      if (policy) {
        const buildNumber = getBuildNumber();
        if (policy.maintenanceMode) {
          log.warn('[Update] Pre-connect: BLOCKED — maintenance mode active');
          evaluateUpdatePolicy(policy);
          throw new Error('WireDog VPN is currently under maintenance. Please try again later.');
        }
        if (buildNumber < policy.minSupportedVersion || policy.forceUpdate) {
          log.warn(`[Update] Pre-connect: BLOCKED — force update required (build ${buildNumber} < min ${policy.minSupportedVersion})`);
          evaluateUpdatePolicy(policy);
          throw new Error('A required update is available. Please update WireDog VPN before connecting.');
        }
        log.info('[Update] Pre-connect: policy check passed, allowing connection');
      } else {
        log.info('[Update] Pre-connect: no policy returned, allowing connection');
      }
    } catch (error) {
      if (error.message.includes('maintenance') || error.message.includes('required update')) {
        throw error;
      }
      // Network error fetching policy — allow connection to proceed
      log.warn(`[Update] Pre-connect: policy fetch failed (${error.message}), allowing connection (fail-open)`);
    }

    try {
      const token = getAuthToken();
      const result = await vpnService.connect(serverId, settings, token);

      // Save last connected server for auto-connect feature
      settingsStore.set('lastServerId', serverId);

      // Persist session for app restart recovery
      settingsStore.set('lastSession', result);

      return result;
    } catch (error) {
      log.error('VPN connect failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:cancel-connect', () => {
    vpnService.cancelConnect();
    return { success: true };
  });

  ipcMain.handle('vpn:disconnect', async (_, options = {}) => {
    const disableProtection = options?.disableProtection !== false; // default true
    log.info(`VPN disconnect request (disableProtection=${disableProtection})`);
    try {
      const token = getAuthToken();
      await vpnService.disconnect(token, disableProtection);
      // Clear persisted session only when fully disabling protection.
      // When keeping PersistentBlock (disableProtection=false), preserve lastSession
      // so boot auto-reconnect can show full server info (city, stateCode, public IP).
      if (disableProtection) {
        settingsStore.delete('lastSession');
      }
      return { success: true };
    } catch (error) {
      log.error('VPN disconnect failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:get-status', async () => {
    const status = await vpnService.getFullStatus();
    // After reboot, currentSession is lost. The fallback in getFullStatus() builds a
    // minimal session from service status (tunnel IP, server ID only). Upgrade it with
    // the full lastSession from electron-store which has city/state and public IP.
    if (status.status === 'connected') {
      const lastSession = settingsStore.get('lastSession');
      if (lastSession) {
        if (!status.session) {
          status.session = lastSession;
        } else if (!status.session.server?.city) {
          // Minimal session from service — upgrade with persisted data
          status.session = lastSession;
        }
      }
    }
    return status;
  });

  ipcMain.handle('vpn:get-stats', async () => {
    try {
      return await vpnService.getStats();
    } catch (error) {
      log.error('Failed to get VPN stats:', error);
      return null;
    }
  });

  ipcMain.handle('vpn:toggle-killswitch', async (_, { enabled }) => {
    log.info(`VPN toggle kill switch: ${enabled}`);
    try {
      await vpnService.toggleKillSwitch(enabled);
      return { success: true };
    } catch (error) {
      log.error('VPN toggle kill switch failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:enable-advanced-killswitch', async () => {
    log.info('VPN enable advanced kill switch');
    try {
      await vpnService.enableAdvancedKillSwitch();
      return { success: true };
    } catch (error) {
      log.error('VPN enable advanced kill switch failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:disable-advanced-killswitch', async () => {
    log.info('VPN disable advanced kill switch');
    try {
      await vpnService.disableAdvancedKillSwitch();
      return { success: true };
    } catch (error) {
      log.error('VPN disable advanced kill switch failed:', error);
      throw error;
    }
  });

  ipcMain.handle('vpn:emergency-reset', async () => {
    log.info('VPN emergency reset requested');
    try {
      await vpnService.emergencyReset();
      settingsStore.delete('lastSession');
      return { success: true };
    } catch (error) {
      log.error('VPN emergency reset failed:', error);
      throw error;
    }
  });

  // Forward VPN status changes to renderer and update tray
  vpnService.onStatusChange((status) => {
    // Upgrade minimal/missing session with persisted data (boot auto-reconnect)
    if (status.status === 'connected' && (!status.session || !status.session.server?.city)) {
      const saved = settingsStore.get('lastSession');
      if (saved) status.session = saved;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vpn:status-changed', status);
    }
    if (compactWindow && !compactWindow.isDestroyed()) {
      compactWindow.webContents.send('vpn:status-changed', status);
    }
    // Update tray menu with new status
    updateTrayMenu();
  });

  // Settings - Persisted in electron-store
  ipcMain.handle('settings:get', () => {
    return settingsStore.store;
  });

  ipcMain.handle('settings:set', (event, newSettings) => {
    try {
      // Merge with existing settings
      const currentSettings = settingsStore.store;
      const merged = { ...currentSettings, ...newSettings };
      settingsStore.store = merged;
      log.info('Settings updated');
      return { success: true, settings: merged };
    } catch (error) {
      log.error('Failed to update settings:', error);
      return { success: false, error: error.message };
    }
  });

  // Auth token management — encrypted via OS keychain (DPAPI on Windows)
  ipcMain.handle('auth:set-token', (event, token) => {
    try {
      if (!token) {
        settingsStore.set('authToken', null);
        return { success: true };
      }
      const encrypted = safeStorage.encryptString(token).toString('base64');
      settingsStore.set('authToken', encrypted);
      log.info('Auth token stored');
      return { success: true };
    } catch (error) {
      log.error('Failed to store auth token:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('auth:get-token', () => {
    try {
      const stored = settingsStore.get('authToken');
      if (!stored) return null;
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      return null;
    }
  });

  ipcMain.handle('auth:clear-token', () => {
    try {
      settingsStore.set('authToken', null);
      log.info('Auth token cleared');
      return { success: true };
    } catch (error) {
      log.error('Failed to clear auth token:', error);
      return { success: false, error: error.message };
    }
  });

  // Compact window operations
  ipcMain.handle('compact:show-main', () => {
    hideCompactWindow();
  });

  ipcMain.handle('compact:exit', () => {
    isQuitting = true;
    app.quit();
  });

  // Auto-launch settings
  ipcMain.handle('app:set-auto-launch', async (event, { enabled, mode }) => {
    if (!app.isPackaged) {
      log.info('Auto-launch skipped in dev mode');
      return { success: true };
    }
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: mode === 'minimize' ? ['--hidden'] : []
      });
      log.info(`Auto-launch ${enabled ? 'enabled' : 'disabled'} with mode: ${mode}`);
      return { success: true };
    } catch (error) {
      log.error('Failed to set auto-launch:', error);
      return { success: false, error: error.message };
    }
  });

  // System info
  ipcMain.handle('system:get-os-version', () => {
    const os = require('os');
    return `${os.type()} ${os.release()}`;
  });

  ipcMain.handle('system:get-geolocation', async () => {
    const http = require('http');
    const https = require('https');

    const get = (url) => new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON from ${url}`)); }
        });
      }).on('error', reject);
    });

    try {
      // ip-api.com returns IP + location in one call (no API key needed, 45 req/min)
      const data = await get('http://ip-api.com/json/?fields=query,city,region,regionName,country');
      if (data.city) {
        return { ip: data.query, city: data.city, region: data.region || data.regionName, country: data.country };
      }
    } catch (err) {
      log.warn('Primary geolocation failed:', err.message);
    }

    try {
      // Fallback: ipify + ipapi.co
      const ipData = await get('https://api.ipify.org?format=json');
      const geoData = await get(`https://ipapi.co/${ipData.ip}/json/`);
      return { ip: ipData.ip, city: geoData.city, region: geoData.region, country: geoData.country_name };
    } catch (err) {
      log.error('Geolocation fetch failed:', err.message);
      return { ip: 'Redacted', city: 'Redacted', region: '', country: 'US' };
    }
  });

  // Log operations
  ipcMain.handle('logs:open-app-logs', () => {
    const logPath = log.transports.file.getFile().path;
    const logDir = path.dirname(logPath);
    shell.openPath(logDir);
  });

  ipcMain.handle('logs:open-service-logs', () => {
    // WireDog service logs are stored in ProgramData
    const serviceLogDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'WireDog', 'logs');
    if (fs.existsSync(serviceLogDir)) {
      shell.openPath(serviceLogDir);
    } else {
      // Fallback to app logs if service logs don't exist
      const logPath = log.transports.file.getFile().path;
      shell.openPath(path.dirname(logPath));
    }
  });

  // Latency measurement
  ipcMain.handle('latency:measure-servers', async (_, servers) => {
    try {
      const latency = require('./latency');
      return await latency.measureAll(servers);
    } catch (error) {
      log.error('Latency measurement failed:', error);
      return {};
    }
  });

  // Split tunneling - app discovery
  ipcMain.handle('split-tunnel:get-installed-apps', async () => {
    try {
      const appDiscovery = require('./utils/appDiscovery');
      return await appDiscovery.getInstalledApps();
    } catch (error) {
      log.error('Failed to get installed apps:', error);
      return [];
    }
  });

  ipcMain.handle('split-tunnel:browse-for-app', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Application',
        filters: [{ name: 'Executables', extensions: ['exe'] }],
        properties: ['openFile']
      });
      if (result.canceled || !result.filePaths.length) return null;
      const exePath = result.filePaths[0];
      const name = path.basename(exePath, '.exe');
      return { name, exePath, icon: null };
    } catch (error) {
      log.error('Failed to browse for app:', error);
      return null;
    }
  });

  // Safe reload - disconnect VPN first
  ipcMain.handle('app:safe-reload', async () => {
    log.info('Safe reload requested - cleaning up VPN');
    try {
      await vpnService.cleanup();
    } catch (error) {
      log.error('VPN cleanup failed during reload:', error);
    }

    // Reload all windows
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
    }
    if (compactWindow && !compactWindow.isDestroyed()) {
      compactWindow.reload();
    }
  });

  log.info('IPC handlers registered');
}

/**
 * Initialize settings store (must be called after Electron is ready)
 */
async function initializeSettingsStore() {
  try {
    const Store = (await import('electron-store')).default;
    settingsStore = new Store({
      name: 'vpn-settings',
      encryptionKey: 'wiredog-vpn-store-v1',
      defaults: {
        protocol: 'wireguard',
        killSwitch: false,
        autoConnect: false,
        splitTunneling: {
          enabled: false,
          mode: 'exclude',
          apps: [],
          ips: []
        },
        blockAdsEnabled: true,
        blockMalwareEnabled: true,
        lastServerId: null,
        authToken: null
      }
    });
    // Lets VPNService fetch a fresh token itself for auto-reconnect and pending-disconnect
    // retries, which originate internally rather than from an IPC call carrying a token.
    try {
      vpnService.setAuthTokenProvider(() => getAuthToken());
    } catch (err) {
      log.warn('VPN: setAuthTokenProvider failed:', err.message);
    }
    log.info('Settings store initialized');
  } catch (error) {
    log.error('Failed to initialize settings store:', error);
    throw error;
  }
}

/**
 * App update system
 * Checks backend policy, then uses electron-updater for download/install.
 */
const https = require('https');
const http = require('http');

function getApiBaseUrl() {
  return process.env.VITE_API_URL
    || (isDev ? 'http://localhost:3001/api' : 'https://api.wiredogvpn.com/api');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

async function checkUpdatePolicy() {
  const url = `${getApiBaseUrl()}/app/config`;
  const platformKey = process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
  try {
    const config = await fetchJson(url);
    const policy = config.platforms?.[platformKey];
    if (!policy) {
      log.info(`[Update] No ${platformKey} platform policy found in response`);
      return null;
    }
    return policy;
  } catch (error) {
    log.error(`[Update] Failed to fetch update policy: ${error.message}`);
    return null;
  }
}

function getBuildNumber() {
  const pkg = require('../package.json');
  return pkg.buildNumber || 0;
}

function sendToAllWindows(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
  if (compactWindow && !compactWindow.isDestroyed()) {
    compactWindow.webContents.send(channel, data);
  }
}

async function evaluateUpdatePolicy(policy) {
  const buildNumber = getBuildNumber();

  // 1. Maintenance mode — blocks everything
  if (policy.maintenanceMode) {
    log.warn('[Update] MAINTENANCE MODE active — blocking app usage');
    sendToAllWindows('update:maintenance', {
      message: policy.updateMessage,
    });
    return;
  }

  // 2. Force update — must update before using app
  if (buildNumber < policy.minSupportedVersion || policy.forceUpdate) {
    log.warn('[Update] Force update required');
    sendToAllWindows('update:force-required', {
      message: policy.updateMessage,
      downloadUrl: policy.downloadUrl,
    });
    return;
  }

  // 3. Optional update available
  if (buildNumber < policy.latestVersion) {
    const automaticUpdates = settingsStore ? settingsStore.get('automaticUpdates', true) : true;
    log.info('[Update] Optional update available');

    if (automaticUpdates) {
      // Silent background download — no UI notification until download completes
      log.info('[Update] Auto-updates ON — initiating silent background download via electron-updater');
      try {
        autoUpdater.setFeedURL({
          provider: 'generic',
          url: policy.downloadUrl,
        });
        autoUpdater.checkForUpdates();
      } catch (error) {
        log.error(`[Update] electron-updater background check failed: ${error.message}`);
      }
    } else {
      log.info('[Update] Auto-updates OFF — notifying user of available update');
      sendToAllWindows('update:available', {
        message: policy.updateMessage,
        downloadUrl: policy.downloadUrl,
        latestVersion: policy.latestVersion,
      });
    }
    return;
  }

  log.info('[Update] App is up to date');
}

/**
 * Setup electron-updater download/install machinery (production only)
 */
function setupElectronUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true;

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    log.info(`[Update] Download progress: ${percent}% (${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB, ${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s)`);
    sendToAllWindows('update:download-progress', {
      percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', () => {
    log.info('[Update] Download complete — update ready to install, notifying renderer');
    sendToAllWindows('update:downloaded', {});
  });

  autoUpdater.on('error', (error) => {
    log.error(`[Update] electron-updater error: ${error.message}`);
  });
}

/**
 * Setup update policy checking, IPC handlers, and periodic polling.
 * Runs in BOTH dev and production — policy enforcement is always active.
 */
function setupUpdateSystem() {
  // IPC handlers for renderer-initiated actions
  ipcMain.handle('update:check-now', async () => {
    log.info('[Update] Manual update check requested by user');
    const policy = await checkUpdatePolicy();
    if (!policy) {
      log.info('[Update] Manual check result: no policy available, reporting up to date');
      return { upToDate: true };
    }

    const buildNumber = getBuildNumber();
    if (buildNumber < policy.latestVersion || buildNumber < policy.minSupportedVersion || policy.forceUpdate) {
      log.info('[Update] Manual check result: update available');
      await evaluateUpdatePolicy(policy);
      return { upToDate: false };
    }
    log.info('[Update] Manual check result: app is up to date');
    return { upToDate: true };
  });

  ipcMain.handle('update:download-now', async () => {
    log.info('[Update] User-initiated download requested');
    try {
      const policy = await checkUpdatePolicy();
      if (policy?.downloadUrl) {
        autoUpdater.setFeedURL({
          provider: 'generic',
          url: policy.downloadUrl,
        });
      }
      await autoUpdater.checkForUpdates();
      log.info('[Update] electron-updater check passed, starting download');
      await autoUpdater.downloadUpdate();
    } catch (error) {
      log.error(`[Update] User-initiated download failed: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle('update:install-now', () => {
    log.info('[Update] User requested install — quitting and installing update');
    autoUpdater.quitAndInstall();
  });

  // Initial policy check — deferred until renderer is ready
  // The React app takes ~2-3s to mount (loading screen), so IPC events sent earlier are lost.
  // We wait for the renderer to signal readiness via 'update:renderer-ready'.
  let initialCheckDone = false;
  ipcMain.handle('update:renderer-ready', async () => {
    if (initialCheckDone) {
      log.info('[Update] Renderer ready signal received (already checked, skipping)');
      return;
    }
    initialCheckDone = true;
    const policy = await checkUpdatePolicy();
    if (policy) evaluateUpdatePolicy(policy);
    else log.info('[Update] Startup check: no policy to evaluate');
  });

  // Periodic policy check every 30 minutes
  setInterval(async () => {
    log.info('[Update] Running periodic update policy check (30-min interval)');
    const policy = await checkUpdatePolicy();
    if (policy) evaluateUpdatePolicy(policy);
    else log.info('[Update] Periodic check: no policy to evaluate');
  }, 30 * 60 * 1000);
}

// App event handlers
app.whenReady().then(async () => {
  log.info('Electron app ready');
  await initializeSettingsStore();
  setupIpcHandlers();

  // Restore last session BEFORE creating window — the renderer calls vpn:get-status
  // on mount, and needs currentSession populated for boot auto-reconnect scenarios.
  const lastSession = settingsStore.get('lastSession');
  if (lastSession) {
    vpnService.restoreSession(lastSession);
  }

  createMainWindow();
  createTray();
  createMenu();

  // Ensure Windows Service is running (attempt to start if not available)
  try {
    log.info('Attempting to ensure VPN Service is running...');
    await vpnService.ensureServiceRunning();
    log.info('VPN Service is ready');
  } catch (error) {
    log.warn('VPN Service startup:', error.message);
    // Don't block app startup if service fails - user can still connect manually
  }

  // Retries any pending-disconnect ledger entries left over from a previous launch/crash
  // (durable — see VPNService.cleanupOrphanedSession) before the crash-recovery check below.
  vpnService.retryPendingDisconnects();

  // Crash recovery: if we have a persisted session with a sessionId but the tunnel is
  // not active (and not in PersistentBlock), release its counter slot via the same durable
  // ledger cleanupOrphanedSession() uses elsewhere, so a network blip here gets retried too
  // instead of leaking the counter outright.
  const lastSessionForCleanup = settingsStore.get('lastSession');
  if (lastSessionForCleanup?.sessionId) {
    try {
      const tunnelStatus = await vpnService.getFullStatus();
      const tunnelDown = tunnelStatus.status !== 'connected';
      const persistentBlockActive = tunnelStatus.advancedKillSwitchActive || false;
      if (tunnelDown && !persistentBlockActive) {
        log.info('[Startup] Stale session detected — releasing counter slot for counter cleanup');
        vpnService.cleanupOrphanedSession(lastSessionForCleanup.sessionId, 'crash recovery — stale session');
        settingsStore.delete('lastSession');
        vpnService.currentSession = null;
      }
    } catch (e) {
      log.warn('[Startup] Could not check tunnel status for crash recovery:', e.message);
    }
  }

  // Initialize auto-launch with saved settings (packaged builds only)
  if (app.isPackaged) {
    try {
      const savedAutoStart = settingsStore.get('autoStart', false);
      const savedAutoStartMode = settingsStore.get('autoStartMode', 'open');
      app.setLoginItemSettings({
        openAtLogin: savedAutoStart,
        args: savedAutoStartMode === 'minimize' ? ['--hidden'] : []
      });
      log.info(`Auto-launch initialized: enabled=${savedAutoStart}, mode=${savedAutoStartMode}`);
    } catch (error) {
      log.warn('Failed to initialize auto-launch:', error.message);
    }
  } else {
    // Clear any stale dev-mode startup entry so the raw electron.exe
    // doesn't launch on boot instead of the packaged app.
    try {
      app.setLoginItemSettings({ openAtLogin: false });
    } catch { /* ignore */ }
  }

  // Policy checking + IPC handlers always run (dev and production)
  setupUpdateSystem();

  // electron-updater download machinery only in production
  if (!isDev) {
    setupElectronUpdater();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  log.info('Application quitting - cleaning up VPN');
  try {
    await vpnService.cleanup();
  } catch (error) {
    log.error('VPN cleanup failed:', error);
  }
});

// Handle app being opened from system tray
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Security: Prevent navigation to external websites
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    if (parsedUrl.origin !== 'http://localhost:5173' && !navigationUrl.startsWith('file://')) {
      event.preventDefault();
    }
  });
});

log.info('Electron main process started');