const log = require('electron-log');
const serviceClient = require('../ipc/service-client');

/**
 * VPN Service - Main facade for VPN operations
 * Now communicates with the Windows Service via Named Pipes
 * The Windows Service handles WireGuard and Kill Switch with WFP
 */
class VPNService {
  constructor() {
    this.currentSession = null;
    this.settings = { killSwitch: false, localMode: false };
    this.statusCallbacks = [];
    this.apiBaseUrl = process.env.VITE_API_URL || 'http://localhost:3001/api';
    this.serviceConnected = false;
    this.serviceConfig = null;
    this.lastConnectionConfig = null; // Cache for reconnecting from PersistentBlock
    this._sessionStore = null;

    // Log API URL for debugging
    log.info('VPN Service initialized');
    log.info('API Base URL:', this.apiBaseUrl);

    // Set up notification handlers
    this.setupNotificationHandlers();
  }

  /**
   * Set up handlers for service notifications
   */
  setupNotificationHandlers() {
    serviceClient.onNotification('status_changed', (params) => {
      log.info('VPN: Status changed:', params);
      this.notifyStatusChange();
    });
  }

  // Lazy-init a separate electron-store for the connection config cache.
  // Must be lazy because electron-store needs app to be ready before use.
  _getSessionStore() {
    if (!this._sessionStore) {
      const Store = require('electron-store');
      this._sessionStore = new Store({
        name: 'vpn-session',
        encryptionKey: 'wiredog-vpn-session-v1'
      });
    }
    return this._sessionStore;
  }

  _saveSessionCache() {
    try {
      this._getSessionStore().set('lastConnectionConfig', this.lastConnectionConfig);
    } catch (err) {
      log.warn('VPN: Failed to save session cache:', err.message);
    }
  }

  _clearSessionCache() {
    try {
      this._getSessionStore().delete('lastConnectionConfig');
    } catch (err) {
      log.warn('VPN: Failed to clear session cache:', err.message);
    }
  }

  _loadSessionCache() {
    try {
      return this._getSessionStore().get('lastConnectionConfig', null);
    } catch (err) {
      log.warn('VPN: Failed to load session cache:', err.message);
      return null;
    }
  }

  /**
   * Ensure service is running (start if not available)
   */
  async ensureServiceRunning() {
    try {
      // Try to connect first
      if (this.serviceConnected) return;

      await serviceClient.connect();
      const ping = await serviceClient.ping();
      log.info('VPN: Service is running (version: %s)', ping.version);
      return true;
    } catch (error) {
      log.warn('VPN: Service not available, attempting to start...');
      try {
        await serviceClient.startService();
        log.info('VPN: Service started, attempting connection...');

        // Try to connect again after starting
        await serviceClient.connect();
        const ping = await serviceClient.ping();
        log.info('VPN: Connected to service (version: %s)', ping.version);
        return true;
      } catch (startError) {
        log.error('VPN: Failed to start service:', startError.message);
        throw new Error('VPN Service could not be started. Please ensure the application was installed with administrator privileges.');
      }
    }
  }

  /**
   * Initialize connection to service
   */
  async initializeService() {
    if (this.serviceConnected) return;

    try {
      await serviceClient.connect();
      const ping = await serviceClient.ping();
      log.info('VPN: Connected to service (version: %s)', ping.version);

      // Fetch service configuration (includes localMode from --local flag)
      try {
        this.serviceConfig = await serviceClient.getConfig();
        log.info('VPN: Service config retrieved:');
        log.info('  - Local Mode:', this.serviceConfig.localMode);
        log.info('  - Dev Mode:', this.serviceConfig.devMode);
        log.info('  - Pipe Name:', this.serviceConfig.pipeName);

        // Set localMode from service config if not already set in settings
        if (!this.settings.localMode && this.serviceConfig.localMode) {
          this.settings.localMode = this.serviceConfig.localMode;
          log.info('VPN: Local mode enabled from service configuration');
        }
      } catch (configError) {
        log.warn('VPN: Could not fetch service config:', configError.message);
        // Continue even if config fetch fails - not critical
      }

      this.serviceConnected = true;

      // Load persisted connection config if not already set.
      // This ensures PersistentBlock reconnect works after a crash/restart.
      if (!this.lastConnectionConfig) {
        this.lastConnectionConfig = this._loadSessionCache();
        if (this.lastConnectionConfig) {
          log.info('VPN: Loaded persisted connection config from disk');
        }
      }
    } catch (error) {
      log.warn('VPN: Service not available, will retry on next operation:', error.message);
      this.serviceConnected = false;
    }
  }

  /**
   * Restore session from persisted data (for boot auto-reconnect scenarios
   * where the service connected before Electron started)
   */
  restoreSession(savedSession) {
    if (!this.currentSession && savedSession) {
      this.currentSession = savedSession;
      log.info('VPN: Restored session from saved state');
    }
  }

  /**
   * Set the API base URL
   */
  setApiUrl(url) {
    this.apiBaseUrl = url;
  }

  /**
   * Connect to a VPN server
   * @param {string} serverId - Server ID to connect to
   * @param {Object} settings - VPN settings (killSwitch, protocol, localMode, etc.)
   * @param {string} token - JWT token for API authentication
   */
  async connect(serverId, settings, token = '') {
    log.info(`VPN: Connect request to server ${serverId}`);

    // Ensure service is running (start it if necessary)
    await this.ensureServiceRunning();

    // Merge settings with service config to ensure localMode is preserved
    // If service config has localMode=true, it should be honored
    if (this.serviceConfig?.localMode) {
      settings.localMode = true;
    }

    log.info(`VPN: Local mode: ${settings.localMode || false}`);
    this.settings = settings;

    // Check if PersistentBlock is active — if so, we can't make API calls (internet blocked).
    // Use cached connection config from the last successful connection instead.
    let isPersistentBlock = false;
    try {
      const status = await serviceClient.getStatus();
      isPersistentBlock = status.advancedKillSwitchActive;
    } catch (e) {
      log.warn('VPN: Could not check persistent block status:', e.message);
    }

    try {
      let config, sessionId, server;

      if (isPersistentBlock && this.lastConnectionConfig) {
        // Reconnecting from PersistentBlock — use cached config (internet is blocked)
        log.info('VPN: PersistentBlock active — using cached connection config');
        ({ config, sessionId, server } = this.lastConnectionConfig);
        // Generate a new sessionId for the new connection
        sessionId = undefined;
      } else {
        // Normal connect — fetch config from backend API
        log.info('VPN: Fetching connection config from backend...');
        log.info('VPN: API URL:', this.apiBaseUrl);
        const requestPayload = {
          serverId,
          localMode: settings.localMode || false
        };
        log.info('VPN: Request payload:', JSON.stringify(requestPayload));

        const headers = {
          'Content-Type': 'application/json',
        };

        // Add Authorization header if token is available
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(`${this.apiBaseUrl}/vpn/connect`, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify(requestPayload)
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(error.error || `API error: ${response.status}`);
        }

        const responseData = await response.json();
        ({ config, sessionId, server } = responseData);

        log.info('VPN: Received connection config');
        log.info('VPN: Server location:', server?.city && server?.stateCode ? `${server.city}, ${server.stateCode}` : 'unknown');

        // Flatten nested peer structure for Windows Service (API now returns config.peer.*)
        if (config.peer) {
          config.endpoint = config.endpoint || config.peer.endpoint;
          config.serverPublicKey = config.serverPublicKey || config.peer.publicKey || config.peer.serverPublicKey;
          config.allowedIPs = config.allowedIPs || config.peer.allowedIPs;
          config.persistentKeepalive = config.persistentKeepalive || config.peer.persistentKeepalive;
        }

        // Cache for potential PersistentBlock reconnection (will update endpoint with resolved IP after connect)
        this.lastConnectionConfig = { config: { ...config }, sessionId, server };
        this._saveSessionCache();
      }

      log.info('VPN: Server Endpoint (IP:Port):', config?.endpoint);
      const publicKey = config?.serverPublicKey;
      log.info('VPN: Server Public Key:', publicKey ? publicKey.substring(0, 10) + '...' : 'undefined');
      log.info('VPN: Assigned Address:', config?.address);

      // 2. Connect via Windows Service (handles WireGuard + Kill Switch)
      log.info('VPN: Connecting via Windows Service...');
      // Build split tunneling params for service
      const splitTunneling = settings.splitTunneling?.enabled ? {
        enabled: true,
        mode: settings.splitTunneling.mode || 'exclude',
        apps: (settings.splitTunneling.apps || []).map(a => ({ name: a.name, exePath: a.exePath })),
        ips: settings.splitTunneling.ips || []
      } : null;

      log.info('VPN: Sending to Windows Service:');
      log.info('  - ServerId:', serverId);
      log.info('  - Config.Endpoint:', config?.endpoint);
      log.info('  - Kill Switch Enabled:', settings.killSwitch);
      log.info('  - Local Mode:', settings.localMode || false);
      log.info('  - Split Tunneling:', splitTunneling ? `${splitTunneling.mode} mode, ${splitTunneling.apps.length} apps, ${splitTunneling.ips.length} IPs` : 'disabled');
      const result = await serviceClient.vpnConnect(serverId, config, settings.killSwitch, settings.localMode || false, splitTunneling);

      // Update cached config with the resolved server IP (not hostname) so PersistentBlock reconnects work
      if (this.lastConnectionConfig && result.serverIp) {
        const parts = this.lastConnectionConfig.config.endpoint.split(':');
        const port = parts.length > 1 ? parts[parts.length - 1] : '443';
        this.lastConnectionConfig.config.endpoint = `${result.serverIp}:${port}`;
        log.info('VPN: Cached config updated with resolved IP:', this.lastConnectionConfig.config.endpoint);
        this._saveSessionCache();
      }

      // 3. Store session info
      this.currentSession = {
        sessionId,
        server,
        assignedIp: server?.exitIp || result.serverIp || result.assignedIp,
        connectedAt: new Date().toISOString()
      };

      log.info('VPN: Connected successfully');
      this.notifyStatusChange();
      return this.currentSession;

    } catch (error) {
      log.error('VPN: Connection failed:', error);

      // Clean up via service. If we were reconnecting from PersistentBlock,
      // re-enable protection so the user doesn't end up unprotected.
      try {
        await serviceClient.vpnDisconnect(!isPersistentBlock);
      } catch (cleanupError) {
        log.warn('VPN: Cleanup failed:', cleanupError.message);
      }

      throw error;
    }
  }

  /**
   * Disconnect from VPN
   * @param {string} token - JWT token for API call
   * @param {boolean} [disableProtection=true] - If false, keep advanced kill switch active (PersistentBlock)
   */
  async disconnect(token = '', disableProtection = true) {
    log.info(`VPN: Disconnect request (disableProtection=${disableProtection})`);

    try {
      // 1. Disconnect via Windows Service (handles WireGuard + Kill Switch)
      await serviceClient.vpnDisconnect(disableProtection);

      // 2. Notify backend (don't fail if this errors)
      if (this.currentSession) {
        try {
          const headers = {
            'Content-Type': 'application/json',
          };

          // Add Authorization header if token is available
          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
          }

          await fetch(`${this.apiBaseUrl}/vpn/disconnect`, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({ sessionId: this.currentSession.sessionId })
          });
        } catch (apiError) {
          log.warn('VPN: Failed to notify backend of disconnect:', apiError);
        }
      }

      this.currentSession = null;
      // Clear cached config when user fully disables protection
      if (disableProtection) {
        this.lastConnectionConfig = null;
        this._clearSessionCache();
      }
      log.info('VPN: Disconnected successfully');
      this.notifyStatusChange();

    } catch (error) {
      log.error('VPN: Disconnect error:', error);
      this.currentSession = null;
      this.notifyStatusChange();
      throw error;
    }
  }

  /**
   * Get full VPN status
   */
  async getFullStatus() {
    try {
      const status = await serviceClient.getStatus();
      // Use in-memory session if we have it (includes full server info + public IP).
      // If null (reboot), build from service status so UI at least shows "Connected".
      let session = this.currentSession;
      if (!session && status.state === 'connected') {
        session = {
          server: status.server || null,
          assignedIp: status.assignedIp || '',
          connectedAt: status.connectedSince || new Date().toISOString()
        };
      }
      return {
        status: status.state,
        session,
        killSwitchEnabled: status.killSwitchActive,
        advancedKillSwitchEnabled: status.advancedKillSwitchEnabled || false,
        advancedKillSwitchActive: status.advancedKillSwitchActive || false
      };
    } catch (error) {
      // Service pipe not connected yet — return disconnected state
      return {
        status: 'disconnected',
        session: this.currentSession,
        killSwitchEnabled: false,
        advancedKillSwitchEnabled: false,
        advancedKillSwitchActive: false
      };
    }
  }

  /**
   * Get connection statistics (bytes transferred)
   */
  async getStats() {
    try {
      const stats = await serviceClient.getStats();
      return {
        bytesReceived: stats.bytesIn.toString(),
        bytesSent: stats.bytesOut.toString()
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Enable advanced (permanent) kill switch setting
   */
  async enableAdvancedKillSwitch() {
    log.info('VPN: Enable advanced kill switch');
    try {
      await this.ensureServiceRunning();
      await serviceClient.enableAdvancedKillSwitch();
      this.settings.permanentKillSwitch = true;
      log.info('VPN: Advanced kill switch enabled');
      this.notifyStatusChange();
    } catch (error) {
      log.error('VPN: Enable advanced kill switch failed:', error);
      throw error;
    }
  }

  /**
   * Disable advanced (permanent) kill switch setting
   */
  async disableAdvancedKillSwitch() {
    log.info('VPN: Disable advanced kill switch');
    try {
      await this.ensureServiceRunning();
      await serviceClient.disableAdvancedKillSwitch();
      this.settings.permanentKillSwitch = false;
      log.info('VPN: Advanced kill switch disabled');
      this.notifyStatusChange();
    } catch (error) {
      log.error('VPN: Disable advanced kill switch failed:', error);
      throw error;
    }
  }

  /**
   * Emergency reset: nuke ALL WFP filters (fail-safe for testing)
   */
  async emergencyReset() {
    log.info('VPN: Emergency reset requested');
    try {
      await this.ensureServiceRunning();
      await serviceClient.emergencyReset();
      this.settings.killSwitch = false;
      this.settings.permanentKillSwitch = false;
      this.currentSession = null;
      this.connectionState = 'disconnected';
      log.info('VPN: Emergency reset complete');
      this.notifyStatusChange();
    } catch (error) {
      log.error('VPN: Emergency reset failed:', error);
      throw error;
    }
  }

  /**
   * Toggle kill switch while VPN is connected
   * @param {boolean} enabled - Enable or disable kill switch
   */
  async toggleKillSwitch(enabled) {
    log.info(`VPN: Toggle kill switch: ${enabled}`);

    try {
      await this.ensureServiceRunning();

      if (enabled) {
        // Get server IP from current session
        if (!this.currentSession) {
          throw new Error('VPN must be connected to enable kill switch');
        }
        const serverIp = this.currentSession.server?.endpoint?.split(':')[0];
        if (!serverIp) {
          throw new Error('Cannot determine server IP');
        }
        await serviceClient.enableKillSwitch(serverIp, 0);
      } else {
        await serviceClient.disableKillSwitch();
      }

      // Update local settings
      this.settings.killSwitch = enabled;
      log.info('VPN: Kill switch toggled successfully');
      this.notifyStatusChange();

    } catch (error) {
      log.error('VPN: Toggle kill switch failed:', error);
      throw error;
    }
  }

  /**
   * Register callback for status changes
   */
  onStatusChange(callback) {
    this.statusCallbacks.push(callback);
  }

  /**
   * Notify all status change listeners
   */
  async notifyStatusChange() {
    const status = await this.getFullStatus();
    this.statusCallbacks.forEach(cb => {
      try {
        cb(status);
      } catch (error) {
        log.error('Status callback error:', error);
      }
    });
  }

  /**
   * Force cleanup (for app shutdown)
   */
  async cleanup() {
    log.info('VPN: Cleanup on shutdown');

    try {
      await serviceClient.vpnDisconnect();
    } catch (error) {
      // Service may not be available, that's ok
      // The service will clean up its own resources
    }

    serviceClient.disconnect();
    this.currentSession = null;
    this.lastConnectionConfig = null;
  }
}

// Export singleton instance
module.exports = new VPNService();
