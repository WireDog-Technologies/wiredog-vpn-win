const log = require('electron-log');
const serviceClient = require('../ipc/service-client');

// Thrown when a connect() attempt is aborted via cancelConnect() (user tapped Connect again
// while connecting/reconnecting). Distinguished from a real failure so callers can skip
// surfacing an error toast for it.
class ConnectCancelledError extends Error {
  constructor() {
    super('Connection cancelled');
    this.name = 'ConnectCancelledError';
  }
}

// Thrown when /vpn/connect rejects the auth token (expired/invalid). Distinguished by a
// fixed sentinel message so the renderer can detect it across the IPC boundary (only
// message/name/stack survive electron's ipcRenderer.invoke error serialization) and route
// the user back to login instead of leaving them stuck on a raw "Invalid token" toast.
class UnauthorizedError extends Error {
  constructor() {
    super('WIREDOG_UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

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
    this._getAuthToken = null; // injected from main.js — () => auth token string

    // --- Connection-counter / auto-reconnect bookkeeping ---
    this.currentServerId = null;
    this.userInitiatedDisconnect = false; // persists across the whole disconnected period
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectBaseDelay = 1.0; // seconds
    this.reconnectMaxDelay = 15.0; // seconds
    this.minimumStableConnectionDuration = 30; // seconds — a connection that drops before this never really established
    this.disconnectNotifyDelayMs = 1500; // time for tunnel to fully stop before notifying backend
    this.connectedSince = null;
    this._reconnectTimer = null;
    // Cooperative cancellation token for whichever connect() call is currently in flight
    // (either a first attempt or an auto-reconnect retry) — set by cancelConnect().
    this._connectAbortToken = null;
    // Guards against firing two concurrent /disconnect calls for the same session (e.g. a
    // crash-recovery retry and a foreground retry landing close together).
    this.sessionsPendingCleanup = new Set();
    this.hasHandledFirstFocusEvent = false;

    // Log API URL for debugging
    log.info('VPN Service initialized');
    log.info('API Base URL:', this.apiBaseUrl);

    // Set up notification handlers
    this.setupNotificationHandlers();
  }

  /**
   * Inject a function that returns the current auth token. Needed because auto-reconnect and
   * pending-disconnect retries originate from inside VPNService itself, not from an IPC call
   * that already carries a token from the renderer.
   */
  setAuthTokenProvider(fn) {
    this._getAuthToken = fn;
  }

  /**
   * Set up handlers for service notifications
   */
  setupNotificationHandlers() {
    serviceClient.onNotification('status_changed', async (params) => {
      log.info('VPN: Status changed:', params);

      // Unexpected drop: we still hold a session, but the service reports the tunnel down and
      // nobody called disconnect()/cancelConnect() intentionally. This is the entry point into
      // the auto-reconnect loop — subsequent retries chain themselves directly from
      // _attemptReconnect's own timer rather than depending on further notifications.
      const status = await this.getFullStatus();
      if (status.status === 'error' && this.currentSession && !this.userInitiatedDisconnect) {
        this._handleUnexpectedDrop();
        return;
      }

      this.notifyStatusChange();
    });
  }

  // Lazy-init a separate electron-store for the connection config cache.
  // Must be lazy because electron-store needs app to be ready before use.
  // Also holds the pending-disconnect ledger (see below) — reusing this store rather than
  // adding a second injected store, since VPNService already owns it.
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

  // --- Pending-disconnect ledger ---
  // A sessionId is written here *before* the network call is attempted, and only removed on
  // confirmed success, so a disconnect lost to a network blip / crash / force-quit survives to
  // be retried on next launch or foreground instead of leaking the backend counter forever.

  _pendingDisconnectIds() {
    try {
      return this._getSessionStore().get('pendingDisconnectIds', []);
    } catch {
      return [];
    }
  }

  _addPendingDisconnect(sessionId) {
    try {
      const ids = new Set(this._pendingDisconnectIds());
      ids.add(sessionId);
      this._getSessionStore().set('pendingDisconnectIds', Array.from(ids));
    } catch (err) {
      log.warn('VPN: Failed to add pending disconnect:', err.message);
    }
  }

  _removePendingDisconnect(sessionId) {
    try {
      const ids = new Set(this._pendingDisconnectIds());
      ids.delete(sessionId);
      this._getSessionStore().set('pendingDisconnectIds', Array.from(ids));
    } catch (err) {
      log.warn('VPN: Failed to remove pending disconnect:', err.message);
    }
  }

  /**
   * Best-effort notification to the backend that a session is no longer valid, so its
   * device-count slot is released. This is the single choke point every code path that could
   * leave a claimed-but-unreleased session routes through.
   *
   * The sessionId is persisted to the durable pending list *before* the network call, and only
   * removed on confirmed success — if the app has no connectivity right now, the call fails
   * silently, but the record survives so retryPendingDisconnects() can retry it later instead of
   * leaking the counter forever. sessionsPendingCleanup guards against firing two concurrent
   * calls for the same session.
   */
  cleanupOrphanedSession(sessionId, reason) {
    if (!sessionId || this.sessionsPendingCleanup.has(sessionId)) return;
    this.sessionsPendingCleanup.add(sessionId);

    log.info(`VPN: cleaning up orphaned session (${reason})`);
    this._addPendingDisconnect(sessionId);

    setTimeout(async () => {
      try {
        const token = this._getAuthToken ? this._getAuthToken() : '';
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const response = await fetch(`${this.apiBaseUrl}/vpn/disconnect`, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({ sessionId }),
        });
        if (response.ok) {
          this._removePendingDisconnect(sessionId);
        }
        // Non-ok: left in the pending list, retried via retryPendingDisconnects() later.
      } catch (err) {
        log.warn('VPN: cleanupOrphanedSession disconnect failed (will retry):', err.message);
        // Left in the pending list — retried via retryPendingDisconnects() later.
      } finally {
        this.sessionsPendingCleanup.delete(sessionId);
      }
    }, this.disconnectNotifyDelayMs);
  }

  /**
   * Retries any /disconnect calls that were owed but never confirmed — e.g. the app had no
   * connectivity right as cleanupOrphanedSession()'s call went out, so nothing ever reached
   * the backend. Safe to call unconditionally: each retry goes through cleanupOrphanedSession()'s
   * own in-flight guard.
   */
  retryPendingDisconnects() {
    for (const sessionId of this._pendingDisconnectIds()) {
      this.cleanupOrphanedSession(sessionId, 'retrying pending disconnect from previous launch');
    }
  }

  /**
   * Called when the app window regains focus. The very first firing coincides with the
   * cold-start retry the app's startup cleanup already performs, so it's skipped there in
   * favor of that one.
   */
  handleAppForeground() {
    if (this.hasHandledFirstFocusEvent) {
      this.retryPendingDisconnects();
    } else {
      this.hasHandledFirstFocusEvent = true;
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
      // Needed so an unexpected drop after a restart-while-connected can still auto-reconnect.
      this.currentServerId = savedSession.server?.id ?? null;
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

    // Cooperative cancellation token for this specific attempt — cancelConnect() flips
    // .cancelled on whatever token is current; checked at the same two checkpoints used below
    // (right before and right after the tunnel actually comes up).
    const abortToken = { cancelled: false };
    this._connectAbortToken = abortToken;

    // Ensure service is running (start it if necessary)
    await this.ensureServiceRunning();

    // Merge settings with service config to ensure localMode is preserved
    // If service config has localMode=true, it should be honored
    if (this.serviceConfig?.localMode) {
      settings.localMode = true;
    }

    log.info(`VPN: Local mode: ${settings.localMode || false}`);
    this.settings = settings;

    this.connectedSince = null;
    if (!this.isReconnecting) {
      this.userInitiatedDisconnect = false;
      this.reconnectAttempts = 0;
    }

    // Check if PersistentBlock is active — if so, we can't make API calls (internet blocked).
    // Use cached connection config from the last successful connection instead.
    let isPersistentBlock = false;
    try {
      const status = await serviceClient.getStatus();
      isPersistentBlock = status.advancedKillSwitchActive;
    } catch (e) {
      log.warn('VPN: Could not check persistent block status:', e.message);
    }

    // Declared outside the try block so the catch clause below can see whether a sessionId
    // was already claimed from the backend (and thus already incremented the counter) before
    // something later in this function threw.
    let sessionId, server, config;

    try {
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
          localMode: settings.localMode || false,
          blockAds: settings.blockAdsEnabled ?? true,
          blockMalware: settings.blockMalwareEnabled ?? true,
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
          // The backend reuses 429 for the 5-device connection cap (the only source of 429 on
          // this endpoint) — surface a clean, actionable message instead of the raw backend text.
          if (response.status === 429 && error.error?.includes('Connection limit exceeded')) {
            throw new Error("You've reached your 5-device limit. Disconnect another device to continue.");
          }
          if (response.status === 401) {
            throw new UnauthorizedError();
          }
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

      this.currentServerId = serverId;

      // A cancel (tap-again-to-cancel) may have arrived while awaiting everything above —
      // check before starting the tunnel.
      if (abortToken.cancelled) throw new ConnectCancelledError();

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

      // The tunnel just came up — if a cancel landed in the narrow window right around this
      // call, tear it back down via the catch block's cleanup below rather than leaving an
      // untracked live tunnel.
      if (abortToken.cancelled) throw new ConnectCancelledError();

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
      this.connectedSince = Date.now();
      this.isReconnecting = false;
      this.reconnectAttempts = 0;

      log.info('VPN: Connected successfully');
      this.notifyStatusChange();
      return this.currentSession;

    } catch (error) {
      if (error instanceof ConnectCancelledError) {
        // User-initiated cancel (tap-again-to-cancel) — expected, not a failure.
        log.info('VPN: Connect cancelled');
      } else if (error instanceof UnauthorizedError) {
        log.warn('VPN: Connect failed — auth token rejected by backend (expired or invalid)');
      } else {
        log.error('VPN: Connection failed:', error);
      }

      // Clean up via service. If we were reconnecting from PersistentBlock,
      // re-enable protection so the user doesn't end up unprotected.
      try {
        await serviceClient.vpnDisconnect(!isPersistentBlock);
      } catch (cleanupError) {
        log.warn('VPN: Cleanup failed:', cleanupError.message);
      }

      // If we obtained a sessionId from the backend (thus incrementing its device counter)
      // before something later in this function failed, release it durably.
      if (sessionId) {
        this.cleanupOrphanedSession(sessionId, 'connect() threw after sessionId obtained');
        if (!this.isReconnecting) {
          this.currentServerId = null;
        }
      }

      throw error;
    }
  }

  /**
   * Cancels an in-progress connect() — either a first attempt (still awaiting the backend or
   * the tunnel starting) or an in-progress auto-reconnect loop (backoff wait or an active retry
   * attempt).
   */
  cancelConnect() {
    log.info('VPN: Cancel connect requested');

    // Flips whichever connect() call is currently in flight (first attempt or an active
    // reconnect retry) — checked cooperatively at the two checkpoints inside connect().
    if (this._connectAbortToken) {
      this._connectAbortToken.cancelled = true;
    }

    if (this.isReconnecting) {
      this.userInitiatedDisconnect = true;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      // A previous retry may have already claimed a session (and thus incremented the counter)
      // before this cancel arrived — release it so the counter stays net-zero.
      if (this.currentSession?.sessionId) {
        this.disconnect('', true).catch(err => log.warn('VPN: cancelConnect disconnect failed:', err.message));
      }
    }
  }

  /**
   * Disconnect from VPN
   * @param {string} token - unused; cleanupOrphanedSession fetches a fresh token via the
   *   injected provider instead, since it can also fire from internal (non-IPC) code paths.
   * @param {boolean} [disableProtection=true] - If false, keep advanced kill switch active (PersistentBlock)
   */
  async disconnect(token = '', disableProtection = true) {
    log.info(`VPN: Disconnect request (disableProtection=${disableProtection})`);

    // Persists across the whole disconnected period so a status transition arriving after
    // disconnect() has already returned is still correctly recognized as user-initiated, not
    // an unexpected drop — reset only at the start of the next connect().
    this.userInitiatedDisconnect = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.currentServerId = null;
    this.connectedSince = null;

    // Null the session BEFORE the service call so the status-change notification handler
    // can't race: if it fires while WireGuard is being torn down it would see
    // currentSession!=null + state=disconnected and wrongly emit 'error'.
    const savedSession = this.currentSession;
    this.currentSession = null;

    try {
      // 1. Disconnect via Windows Service (handles WireGuard + Kill Switch)
      await serviceClient.vpnDisconnect(disableProtection);

      // 2. Notify backend — durable cleanup (persisted + retried on failure) rather than a bare
      // fire-and-forget fetch, so a disconnect lost to a network blip doesn't leak the counter.
      if (savedSession) {
        this.cleanupOrphanedSession(savedSession.sessionId, 'user-initiated disconnect');
      }

      // Clear cached config when user fully disables protection
      if (disableProtection) {
        this.lastConnectionConfig = null;
        this._clearSessionCache();
      }
      log.info('VPN: Disconnected successfully');
      this.notifyStatusChange();

    } catch (error) {
      log.error('VPN: Disconnect error:', error);
      this.notifyStatusChange();
      throw error;
    }
  }

  /**
   * Unexpected tunnel disconnect — we still hold a session but the service reports the tunnel
   * down and nobody called disconnect()/cancelConnect(). Cleans up the stale session (if it
   * never proved stable) and kicks off the auto-reconnect loop.
   */
  _handleUnexpectedDrop() {
    log.info('VPN: Unexpected tunnel disconnect — clearing stale session');

    const staleSessionId = this.currentSession?.sessionId;
    const serverId = this.currentServerId;
    const wasStable = this.connectedSince != null &&
      (Date.now() - this.connectedSince) >= this.minimumStableConnectionDuration * 1000;

    // Connection never proved itself stable — clean up its slot rather than letting the
    // upcoming reconnect attempt leak another increment on top of this orphaned one.
    // (A connection that *was* stable and then drops is not cleaned up here — the reconnect
    // attempt below claims a brand-new session instead.)
    if (!wasStable && staleSessionId) {
      this.cleanupOrphanedSession(
        staleSessionId,
        `dropped before ${this.minimumStableConnectionDuration}s stability threshold`
      );
    }

    this.currentSession = null;
    this.connectedSince = null;
    this._clearSessionCache();

    if (serverId) {
      this._attemptReconnect(serverId);
    }

    // _attemptReconnect() above already flipped isReconnecting — broadcast now so the UI
    // shows 'connecting' immediately instead of a stale snapshot.
    this.notifyStatusChange();
  }

  /**
   * Auto-reconnect after an unexpected tunnel drop. Exponential backoff with jitter (1s, 2s,
   * 4s, 8s, 15s max by default), up to maxReconnectAttempts, using the same server/settings as
   * the connection that just dropped.
   */
  _attemptReconnect(serverId) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.isReconnecting = false;
      log.error(`VPN: Reconnection failed after ${this.maxReconnectAttempts} attempts`);
      if (this.currentSession?.sessionId) {
        this.cleanupOrphanedSession(this.currentSession.sessionId, 'reconnect attempts exhausted');
      }
      this.currentServerId = null;
      this.notifyStatusChange();
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts += 1;
    log.warn(`VPN: Auto-reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

    const baseDelay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectMaxDelay
    );
    const jitterFactor = 0.5 + Math.random(); // 0.5..1.5
    const delay = baseDelay * jitterFactor;

    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      if (this.userInitiatedDisconnect) return;
      try {
        const token = this._getAuthToken ? this._getAuthToken() : '';
        await this.connect(serverId, this.settings, token);
        // Success: connect() already reset isReconnecting/reconnectAttempts/connectedSince.
      } catch (err) {
        log.warn(`VPN: Reconnect attempt ${this.reconnectAttempts} failed: ${err.message}`);
        if (!this.userInitiatedDisconnect) {
          this._attemptReconnect(serverId);
        }
      }
    }, delay);
  }

  /**
   * Called once at app startup. Retries any pending-disconnect ledger entries — pure HTTP,
   * independent of Windows Service/tunnel availability.
   */
  async performStartupCleanup() {
    this.retryPendingDisconnects();
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
        // During an auto-reconnect backoff wait, the tunnel is genuinely down (no session) so
        // status.state would report 'disconnected'/'error' — override so the UI shows the same
        // in-progress affordance (and cancel button) as a first connect attempt.
        status: this.isReconnecting ? 'connecting' : status.state,
        session,
        killSwitchEnabled: status.killSwitchActive,
        advancedKillSwitchEnabled: status.advancedKillSwitchEnabled || false,
        advancedKillSwitchActive: status.advancedKillSwitchActive || false,
        isReconnecting: this.isReconnecting
      };
    } catch (error) {
      // Service pipe not connected yet — return disconnected state
      return {
        status: this.isReconnecting ? 'connecting' : 'disconnected',
        session: this.currentSession,
        killSwitchEnabled: false,
        advancedKillSwitchEnabled: false,
        advancedKillSwitchActive: false,
        isReconnecting: this.isReconnecting
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

      this.userInitiatedDisconnect = true;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      this.currentServerId = null;
      this.connectedSince = null;
      if (this.currentSession) {
        this.cleanupOrphanedSession(this.currentSession.sessionId, 'emergency reset');
      }

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

    // Persist the sessionId to the pending-disconnect ledger so it survives even if the process
    // exits before cleanupOrphanedSession's own delayed network attempt gets to run — the actual
    // decrement then happens via retryPendingDisconnects() on the next launch.
    if (this.currentSession) {
      this.cleanupOrphanedSession(this.currentSession.sessionId, 'app quit');
    }

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
