const log = require('electron-log');
const serviceClient = require('../ipc/service-client');
const apiRelay = require('../apiRelay');

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

// Messages for the 403s /vpn/connect tags with a machine-readable `code`. An untagged 403 falls
// back to the backend's own text.
// A sleep at least this long (a little under the backend's idle cleanup) is treated as having lost
// the session on the backend. This is the default for a backend that does not report its lease; a
// backend that does (leaseHours in the /vpn/connect response) sets the limit to the lease minus an hour.
const LONG_SLEEP_MS = 11 * 60 * 60 * 1000;
// Failed reconnect attempts on the same server before a user with Auto-Reconnect on is moved to another server.
const FALLBACK_AFTER_ATTEMPTS = 2;
// How long a reconnect attempt waits for the dropped session's release to finish before asking for a
// new one. The wait only matters at the 5-device limit; a refusal there just retries on the next attempt.
const RELEASE_WAIT_MS = 2000;

const CONNECT_FORBIDDEN_MESSAGES = {
  two_factor_setup_required: 'Your organization requires two-factor authentication. Set it up on your dashboard, then try again.',
  server_not_available: 'Your organization does not have access to this location.',
  subscription_required: 'An active subscription is required to connect.',
};

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
    this.configStore = null; // injected from main.js — the settings store (last persisted session, released-session ledger)

    // --- Connection-counter / auto-reconnect bookkeeping ---
    this.currentServerId = null;
    // The organization gateway (named Dedicated IP) the current connection uses, if any. Kept so
    // auto-reconnect goes back through the same gateway instead of the shared network.
    this.currentGatewayId = null;
    this.userInitiatedDisconnect = false; // persists across the whole disconnected period
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectBaseDelay = 1.0; // seconds
    // Set when the last reconnect attempt failed because of the SERVER (the backend could not set a
    // session up on the node, or the tunnel could not be established), not the user's own network.
    this._lastAttemptServerSide = false;
    // Servers that already failed during this reconnect, so a later attempt does not pick them again.
    this._reconnectExcluded = new Set();
    this.reconnectMaxDelay = 15.0; // seconds
    this.minimumStableConnectionDuration = 30; // seconds — a connection that drops before this never really established
    this.disconnectNotifyDelayMs = 1500; // time for tunnel to fully stop before notifying backend
    this.connectedSince = null;
    this._reconnectTimer = null;
    // Cooperative cancellation token for whichever connect() call is currently in flight
    // (either a first attempt or an auto-reconnect retry) — set by cancelConnect().
    this._connectAbortToken = null;
    this._connectsInFlight = 0;
    this._connectInFlight = null; // { serverId, gatewayId, promise } for the connect() now running
    // Guards against firing two concurrent /disconnect calls for the same session (e.g. a
    // crash-recovery retry and a foreground retry landing close together).
    this.sessionsPendingCleanup = new Set();
    // The promise of each /disconnect currently in flight, so a caller that needs the slot freed
    // (a reconnect about to ask for a new one) can wait for it instead of racing it.
    this._cleanupInFlight = new Map();
    this.authExpired = false; // set when the backend rejected our token during an auto-reconnect
    // Set when the auto-reconnect loop used up all its attempts. The screen needs to be told, because the
    // service by then simply reports 'disconnected', which the UI ignores while it still shows 'connecting'.
    this.reconnectGaveUp = false;
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

      // Without a kill switch the service, on a lost connection, tears everything down and reports
      // 'disconnected' rather than 'error' (internet is restored on the physical adapter). Without
      // this the app is left holding a session for a tunnel that is gone, and nothing reconnects.
      // connectedSince is only set by a connect() in this run, so a session merely restored after an
      // app restart or reboot never triggers it.
      if (status.status === 'disconnected' && this.currentSession && this.connectedSince != null &&
          !this.userInitiatedDisconnect && !this.isReconnecting) {
        log.warn('VPN: Service reports disconnected while a session is held â€” treating as an unexpected drop');
        this._handleUnexpectedDrop();
        return;
      }

      this.notifyStatusChange();
    });
  }

  /**
   * The machine is going to sleep (lid closed, hibernate). Nothing to do: the tunnel cannot be
   * serviced while asleep. Logged so a bad wake-up can be read against the sleep that caused it.
   */
  handleSuspend() {
    this.suspendedAt = Date.now();
    log.info(`POWER: suspend (connected=${!!this.currentSession}, session=${this._short(this.currentSession?.sessionId)})`);
  }

  /**
   * The machine woke up. Recovery is left to the service's health monitor, which holds off judging
   * the tunnel for a grace period after a sleep and then reconnects through the usual drop path if
   * the tunnel really is gone. This only records the wake-up and the counter state for the logs.
   */
  handleResume() {
    const asleepMs = this.suspendedAt ? Date.now() - this.suspendedAt : null;
    this.suspendedAt = null;
    const asleepFor = asleepMs === null ? null : Math.round(asleepMs / 1000);
    log.info(`POWER: resume after ${asleepFor === null ? 'unknown' : asleepFor + 's'} (connected=${!!this.currentSession}, reconnecting=${this.isReconnecting}, session=${this._short(this.currentSession?.sessionId)})`);
    if (this.currentSession) this.logConnectionCounter('after resume');

    // Asleep long enough that the backend's idle cleanup (12h) has probably removed this session's
    // peer: the saved credentials can no longer work, so skip the retry that is bound to fail and
    // ask for a new session now. Shorter sleeps are left to recover by themselves (the service's
    // health monitor holds off after a wake-up, and reconnects if the tunnel is really gone).
    if (asleepMs !== null && asleepMs >= this._longSleepMs() && this.currentSession &&
        !this.userInitiatedDisconnect && !this.isReconnecting) {
      this._rebuildAfterLongSleep().catch(err => log.error('POWER: rebuild after long sleep failed:', err.message));
    }
  }

  /**
   * Tear down the stale tunnel and reconnect through the normal drop path, which releases the old
   * session and requests a new one (with backoff, so a network that is not back yet is retried).
   */
  /** How long a sleep must be to assume the backend dropped the session: the lease minus an hour. */
  _longSleepMs() {
    const lease = this.currentSession?.leaseHours;
    return Number.isFinite(lease) && lease > 1 ? (lease - 1) * 60 * 60 * 1000 : LONG_SLEEP_MS;
  }

  async _rebuildAfterLongSleep() {
    log.info('POWER: long sleep, rebuilding the connection with a new session');
    // Flag first so the status handler does not also treat the teardown below as a drop.
    this.isReconnecting = true;
    try {
      await serviceClient.vpnDisconnect(!this.settings?.permanentKillSwitch);
    } catch (err) {
      log.warn('POWER: teardown before rebuild failed:', err.message);
    }
    this._handleUnexpectedDrop();
  }

  /**
   * Inject the settings store. VPNService reads the last session main.js persisted from it, and
   * keeps the confirmed-released session ledger in it.
   */
  setConfigStore(store) {
    this.configStore = store;
  }

  // --- Connection-counter diagnostics ---

  /**
   * First 8 chars of a sessionId — enough to correlate log lines (and the backend's records)
   * without writing the full token into a log users may export.
   */
  _short(sessionId) {
    return sessionId ? String(sessionId).slice(0, 8) : 'none';
  }

  /**
   * Asks the backend what its active_connection_counter currently says and logs it next to what
   * this device believes it holds. A counter that rises with no matching local event shows up here
   * as a `local=none backend>0` mismatch (another device, or a leaked session). Purely diagnostic:
   * never throws, never blocks the caller, and skipped when signed out.
   */
  logConnectionCounter(context) {
    const token = this._getAuthToken ? this._getAuthToken() : '';
    if (!token) return;

    const local = this._short(this.currentSession?.sessionId);
    const pending = this._pendingDisconnectIds().map(id => this._short(id)).join(',');
    const state = this.currentSession ? (this.isReconnecting ? 'reconnecting' : 'connected') : 'disconnected';

    (async () => {
      try {
        const response = await apiRelay.apiFetch(`${this.apiBaseUrl}/vpn/status`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'include',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json();
        log.info(`CONN_COUNTER [${context}]: backend=${status.activeConnections}/${status.maxConnections} localSession=${local} state=${state} pendingDisconnects=[${pending}]`);
      } catch (err) {
        log.warn(`CONN_COUNTER [${context}]: status check failed: ${err.message}`);
      }
    })();
  }

  /**
   * True only when the tunnel is genuinely idle: no session, no connect in flight and no
   * reconnect loop. Latency probes made at any other time are routed through the connected
   * server and come back inflated.
   */
  async isIdleForLatency() {
    if (this.currentSession || this.isReconnecting || this._connectsInFlight > 0) return false;
    try {
      const status = await serviceClient.getStatus();
      return status.state === 'disconnected';
    } catch {
      // Can't tell: the service being unreachable means there is no tunnel to skew anything.
      return true;
    }
  }

  /**
   * Inject the store for the connection config cache and the pending-disconnect ledger (see below).
   * electron-store is ESM-only, so it cannot be require()d here; main.js creates it (dynamic import,
   * after the app is ready) and hands it over. Until then the cache and ledger calls fail softly.
   */
  setSessionStore(store) {
    this._sessionStore = store;
  }

  _getSessionStore() {
    if (!this._sessionStore) throw new Error('session store not initialized yet');
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

  // Sessions whose /disconnect the backend has confirmed (last 50, persisted). The backend's
  // /disconnect decrements the account's counter every time it is called for a valid token, even
  // for a session already released, so a second release would silently free another device's
  // slot. Anything in this list is never released again.
  _releasedSessionIds() {
    if (!this.configStore) return [];
    return this.configStore.get('releasedSessionIds', []);
  }

  _markReleased(sessionId) {
    if (!this.configStore) return;
    const ids = this._releasedSessionIds().filter(id => id !== sessionId);
    ids.push(sessionId);
    this.configStore.set('releasedSessionIds', ids.slice(-50));
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
  cleanupOrphanedSession(sessionId, reason, { immediate = false } = {}) {
    if (!sessionId) {
      log.warn(`CONN_COUNTER: nothing to release, no session id (${reason})`);
      return Promise.resolve();
    }
    if (this._releasedSessionIds().includes(sessionId)) {
      log.info(`CONN_COUNTER: session ${this._short(sessionId)} already released, skipping duplicate (${reason})`);
      this._removePendingDisconnect(sessionId);
      return Promise.resolve();
    }
    if (this.sessionsPendingCleanup.has(sessionId)) {
      log.info(`CONN_COUNTER: /disconnect for ${this._short(sessionId)} already in flight, skipping duplicate (${reason})`);
      return this._cleanupInFlight.get(sessionId) || Promise.resolve();
    }
    this.sessionsPendingCleanup.add(sessionId);

    log.info(`CONN_COUNTER: -1 queued /disconnect for session ${this._short(sessionId)} (${reason})`);
    this._addPendingDisconnect(sessionId);

    // `immediate` skips the grace period meant for a tunnel that is still stopping: when the tunnel
    // is already down (an unexpected drop, a quit that has torn it down first) there is nothing to wait for.
    const delay = immediate ? 0 : this.disconnectNotifyDelayMs;
    const releasePromise = new Promise((resolve) => {
      setTimeout(async () => {
        try {
          const token = this._getAuthToken ? this._getAuthToken() : '';
          const headers = { 'Content-Type': 'application/json' };
          if (token) headers['Authorization'] = `Bearer ${token}`;
          const response = await apiRelay.apiFetch(`${this.apiBaseUrl}/vpn/disconnect`, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({ sessionId }),
          });
          if (response.ok) {
            this._removePendingDisconnect(sessionId);
            this._markReleased(sessionId);
            log.info(`CONN_COUNTER: -1 /disconnect confirmed for session ${this._short(sessionId)} (${reason})`);
            this.logConnectionCounter('after disconnect');
          } else {
            log.error(`CONN_COUNTER: /disconnect FAILED for session ${this._short(sessionId)} (${reason}): HTTP ${response.status} — counter stays incremented until retried`);
          }
          // Non-ok: left in the pending list, retried via retryPendingDisconnects() later.
        } catch (err) {
          log.error(`CONN_COUNTER: /disconnect FAILED for session ${this._short(sessionId)} (${reason}): ${err.message} — counter stays incremented until retried`);
          // Left in the pending list — retried via retryPendingDisconnects() later.
        } finally {
          this.sessionsPendingCleanup.delete(sessionId);
          this._cleanupInFlight.delete(sessionId);
          resolve();
        }
      }, delay);
    });
    this._cleanupInFlight.set(sessionId, releasePromise);
    return releasePromise;
  }

  /**
   * Retries any /disconnect calls that were owed but never confirmed — e.g. the app had no
   * connectivity right as cleanupOrphanedSession()'s call went out, so nothing ever reached
   * the backend. Safe to call unconditionally: each retry goes through cleanupOrphanedSession()'s
   * own in-flight guard.
   */
  retryPendingDisconnects({ immediate = false } = {}) {
    return Promise.all(this._pendingDisconnectIds().map(sessionId =>
      this.cleanupOrphanedSession(sessionId, 'retrying pending disconnect from previous launch', { immediate })
    ));
  }

  /**
   * Called when the app window regains focus. The very first firing coincides with the
   * cold-start retry the app's startup cleanup already performs, so it's skipped there in
   * favor of that one.
   */
  handleAppForeground() {
    if (this.hasHandledFirstFocusEvent) {
      this.retryPendingDisconnects();
      this.logConnectionCounter('app foreground');
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
      this.currentGatewayId = savedSession.gatewayId ?? null;
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
   * Connect to a VPN server (see _connect). Counts attempts in flight so latency probing can tell
   * "tunnel coming up" from "idle" without waiting for a session to exist.
   */
  /**
   * Whether the backend answers from here. Cheap, short-timeout probe; any non-5xx reply counts.
   */
  async _backendReachable() {
    try {
      const response = await apiRelay.apiFetch(`${this.apiBaseUrl}/app/config`, { signal: AbortSignal.timeout(4000) });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  async connect(serverId, settings, token = '', gatewayId = null) {
    // Single flight. Two triggers firing together (auto-connect plus a click, or a reconnect timer
    // landing on a manual connect) would each call /vpn/connect before either has recorded its
    // session; the second would overwrite the first and orphan its +1 on the counter. A duplicate
    // for the same target joins the attempt already running; a different target waits for a
    // cancelled attempt to unwind, and is otherwise turned away.
    const inFlight = this._connectInFlight;
    if (inFlight) {
      if (inFlight.serverId === serverId && (inFlight.gatewayId ?? null) === (gatewayId ?? null)) {
        log.warn(`CONN_COUNTER: duplicate connect to ${serverId} joined the attempt already in flight`);
        return inFlight.promise;
      }
      if (this._connectAbortToken?.cancelled) {
        log.info('VPN: Waiting for a cancelled connect to finish before starting the next one');
        await inFlight.promise.catch(() => {});
      } else {
        log.warn(`CONN_COUNTER: duplicate connect rejected — another connect (${inFlight.serverId}) is already in flight`);
        throw new Error('Another connection attempt is already in progress.');
      }
    }

    this._connectsInFlight += 1;
    const entry = { serverId, gatewayId, promise: null };
    entry.promise = (async () => {
      try {
        return await this._connect(serverId, settings, token, gatewayId);
      } finally {
        this._connectsInFlight -= 1;
        if (this._connectInFlight === entry) this._connectInFlight = null;
      }
    })();
    this._connectInFlight = entry;
    return entry.promise;
  }

  /**
   * Connect to a VPN server
   * @param {string} serverId - Server ID to connect to
   * @param {Object} settings - VPN settings (killSwitch, protocol, localMode, etc.)
   * @param {string} token - JWT token for API authentication
   * @param {number|null} gatewayId - Which of the organization's named Dedicated IP gateways was
   *   picked. Omitted for the shared network.
   */
  async _connect(serverId, settings, token = '', gatewayId = null) {
    log.info(`VPN: Connect request to server ${serverId}${gatewayId ? ` (gateway ${gatewayId})` : ''} (reconnecting=${this.isReconnecting}, heldSession=${this._short(this.currentSession?.sessionId)})`);

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
    this.authExpired = false;
    this.reconnectGaveUp = false;
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
      // A kill switch is holding the network: send backend requests through the Rescue Relay first.
      apiRelay.setBlockedHint(isPersistentBlock || status.state === 'error');
    } catch (e) {
      log.warn('VPN: Could not check persistent block status:', e.message);
    }

    // Declared outside the try block so the catch clause below can see whether a sessionId
    // was already claimed from the backend (and thus already incremented the counter) before
    // something later in this function threw.
    let sessionId, server, config, leaseHours;

    try {
      // Under PersistentBlock the saved config is only a fallback: it points at a peer the backend may
      // have removed (idle cleanup), and it can never work again then. Prefer fresh credentials, and
      // use the saved ones only when the backend cannot be reached from here.
      if (isPersistentBlock && this.lastConnectionConfig && !(await this._backendReachable())) {
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
        if (gatewayId) requestPayload.dedicatedIpId = gatewayId;
        log.info('VPN: Request payload:', JSON.stringify(requestPayload));

        const headers = {
          'Content-Type': 'application/json',
        };

        // Add Authorization header if token is available
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await apiRelay.apiFetch(`${this.apiBaseUrl}/vpn/connect`, {
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
          // 403s the backend tags with a machine-readable `code` get a specific message. Plain
          // 403s fall through to the backend's own text.
          if (response.status === 403 && CONNECT_FORBIDDEN_MESSAGES[error.code]) {
            const forbidden = new Error(CONNECT_FORBIDDEN_MESSAGES[error.code]);
            forbidden.code = error.code;
            throw forbidden;
          }
          const failure = new Error(error.error || `API error: ${response.status}`);
          // A 5xx here means the backend could not set the session up on the node: that server is the problem.
          failure.serverSide = response.status >= 500;
          throw failure;
        }

        const responseData = await response.json();
        ({ config, sessionId, server } = responseData);
        leaseHours = responseData.leaseHours;

        // /connect just incremented the counter. If we were already holding a session, assigning
        // over it orphans that increment until something else releases it: the classic counter leak.
        // Release anything else still held (in memory, or the last session main.js persisted): this
        // is the last chance before the new session overwrites it.
        // (Sessions the backend already confirmed released are skipped, so the log only warns about a
        // real leak risk: a drop releases the old session a moment before the reconnect claims a new one.)
        const alreadyReleased = this._releasedSessionIds();
        const supersededIds = new Set([
          this.currentSession?.sessionId,
          this.configStore?.get('lastSession')?.sessionId,
        ].filter(id => id && id !== sessionId && !alreadyReleased.includes(id)));
        for (const oldId of supersededIds) {
          log.warn(`CONN_COUNTER: /connect granted session ${this._short(sessionId)} but ${this._short(oldId)} was never released — releasing the old one`);
          this.cleanupOrphanedSession(oldId, 'superseded by a new connection', { immediate: true });
        }
        log.info(`CONN_COUNTER: +1 /connect granted session ${this._short(sessionId)} server=${serverId} reconnect=${this.isReconnecting}`);

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
      this.currentGatewayId = gatewayId;

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
      let result;
      try {
        result = await serviceClient.vpnConnect(serverId, config, settings.killSwitch, settings.localMode || false, splitTunneling);
      } catch (serviceErr) {
        // -1003 = the service could not bring the tunnel up with this server (no handshake).
        if (serviceErr && serviceErr.code === -1003) serviceErr.serverSide = true;
        throw serviceErr;
      }

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
      // publicIp = the backend-assigned per-session SNAT exit IP (server.exitIp, shared pool or
      // Dedicated IP) — this is what external services actually see when the tunnel is active, and
      // it is shown instead of asking a third-party lookup service through the tunnel. There is no
      // fallback to server.ipAddress: that is only the VPN server's own address, not an exit IP.
      // Empty when the backend doesn't provide one; the UI then shows "Unknown".
      this.currentSession = {
        sessionId,
        server,
        gatewayId,
        assignedIp: server?.exitIp || result.serverIp || result.assignedIp,
        publicIp: server?.exitIp || '',
        // The backend's idle limit for this session (hours); drives the long-sleep rule above.
        leaseHours,
        connectedAt: new Date().toISOString()
      };
      this.connectedSince = Date.now();
      this.isReconnecting = false;
      this.reconnectAttempts = 0;

      apiRelay.setBlockedHint(false);
      log.info(`VPN: Connected successfully (session=${this._short(sessionId)}, lease=${leaseHours ?? 'unreported'}h)`);
      this.logConnectionCounter('after connect');
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
      // A failed retry inside the auto-reconnect loop must not lift a kill switch the service is
      // holding: vpnDisconnect(true) does a full cleanup and opens the internet. The block stays until
      // the reconnect succeeds or the user clicks Disconnect.
      const holdBlock = this.isReconnecting && !(error instanceof ConnectCancelledError) &&
        (this.settings?.killSwitch || this.settings?.permanentKillSwitch);
      if (holdBlock) {
        log.info('VPN: Reconnect attempt failed, leaving the kill switch block in place');
      } else {
        try {
          await serviceClient.vpnDisconnect(!isPersistentBlock);
        } catch (cleanupError) {
          log.warn('VPN: Cleanup failed:', cleanupError.message);
        }
      }

      // If we obtained a sessionId from the backend (thus incrementing its device counter)
      // before something later in this function failed, release it durably.
      if (sessionId) {
        log.warn(`CONN_COUNTER: connect failed after /connect granted session ${this._short(sessionId)} — releasing`);
        this.cleanupOrphanedSession(sessionId, 'connect() threw after sessionId obtained');
        if (!this.isReconnecting) {
          this.currentServerId = null;
          this.currentGatewayId = null;
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
    this.reconnectGaveUp = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.currentServerId = null;
    this.currentGatewayId = null;
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
        log.info(`CONN_COUNTER: disconnect() releasing session ${this._short(savedSession.sessionId)}`);
        this.cleanupOrphanedSession(savedSession.sessionId, 'user-initiated disconnect');
      } else {
        log.warn('CONN_COUNTER: disconnect() had no session to release — nothing sent to backend');
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
    this._lastAttemptServerSide = false;
    this._reconnectExcluded.clear();

    const staleSessionId = this.currentSession?.sessionId;
    const serverId = this.currentServerId;
    const gatewayId = this.currentGatewayId;
    const wasStable = this.connectedSince != null &&
      (Date.now() - this.connectedSince) >= this.minimumStableConnectionDuration * 1000;

    // Release the dropped session whether or not it was stable. The reconnect below claims a
    // brand-new session (+1); without a /disconnect for this one its slot is lost for good, since
    // neither stale-session cleanup nor subscription expiry ever lowers the backend's counter.
    // (Leaving stable drops unreleased was a known gap that leaked a slot per drop on macOS.)
    // The tunnel is already down, so nothing needs to settle first: release right away, which also
    // keeps the replacement /connect from tripping the device limit at 5/5.
    log.warn(`CONN_COUNTER: unexpected drop, session=${this._short(staleSessionId)} stable=${wasStable} — releasing it, then reconnecting`);
    if (staleSessionId) {
      this.cleanupOrphanedSession(
        staleSessionId,
        wasStable
          ? 'unexpected drop of a stable connection'
          : `dropped before ${this.minimumStableConnectionDuration}s stability threshold`,
        { immediate: true }
      );
    }

    this.currentSession = null;
    this.connectedSince = null;
    this._clearSessionCache();

    if (serverId) {
      this._attemptReconnect(serverId, gatewayId);
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
  _attemptReconnect(serverId, gatewayId = this.currentGatewayId) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.isReconnecting = false;
      log.error(`VPN: Reconnection failed after ${this.maxReconnectAttempts} attempts`);
      this.reconnectGaveUp = true;
      if (this.currentSession?.sessionId) {
        this.cleanupOrphanedSession(this.currentSession.sessionId, 'reconnect attempts exhausted');
      }
      this.currentServerId = null;
      this.currentGatewayId = null;
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
    const delay = baseDelay * jitterFactor * 1000; // the base/max delays are in seconds; setTimeout wants ms

    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      if (this.userInitiatedDisconnect) return;
      try {
        // Free the old slot first. At 5 of 5 devices, asking for a new session before the old one is
        // released is refused as "device limit"; the release may have been waiting for the network.
        await Promise.race([
          this.retryPendingDisconnects({ immediate: true }),
          new Promise((resolve) => setTimeout(resolve, RELEASE_WAIT_MS)),
        ]);
        const token = this._getAuthToken ? this._getAuthToken() : '';

        // The same server keeps failing (rebuilt, down, or removed): with "Auto-Reconnect to another server" on, try the
        // lowest-latency other server instead. Skipped for organization gateways (a Dedicated IP is
        // tied to its server). Later attempts re-check, so a recovered server is not abandoned for good
        // by one bad moment: the original is tried again only if no alternative can be found.
        let targetServerId = serverId;
        // Read the saved choice, not the settings captured at connect time: the user may have flipped it since.
        let switchServers = this.settings?.reconnectToAnotherServer ?? true;
        try { switchServers = this.configStore?.get('reconnectToAnotherServer', switchServers); } catch { /* keep the captured value */ }
        // Switch right after the first failure that was the SERVER's fault (retrying it would get the same
        // answer); for other failures wait until it has failed FALLBACK_AFTER_ATTEMPTS times.
        const shouldSwitch = this._lastAttemptServerSide || this.reconnectAttempts > FALLBACK_AFTER_ATTEMPTS;
        if (shouldSwitch && switchServers && !gatewayId) {
          try {
            this._reconnectExcluded.add(serverId);
            const alternative = await this._pickFallbackServerId(this._reconnectExcluded, token);
            if (alternative) {
              log.warn(`VPN: ${serverId} failed (${this._lastAttemptServerSide ? 'server error' : `${this.reconnectAttempts - 1} attempts`}), trying ${alternative} instead`);
              targetServerId = alternative;
            }
          } catch (pickError) {
            log.warn(`VPN: Could not choose a fallback server: ${pickError.message}`);
          }
        }

        this._lastTargetServerId = targetServerId;
        await this.connect(targetServerId, this.settings, token, gatewayId);
        // Success: connect() already reset isReconnecting/reconnectAttempts/connectedSince.
        this._lastAttemptServerSide = false;
        this._reconnectExcluded.clear();
      } catch (err) {
        log.warn(`VPN: Reconnect attempt ${this.reconnectAttempts} failed: ${err.message}`);
        this._lastAttemptServerSide = !!(err && err.serverSide);
        // A server that failed on its own is not tried again during this reconnect.
        if (this._lastAttemptServerSide && this._lastTargetServerId) this._reconnectExcluded.add(this._lastTargetServerId);
        if (err instanceof UnauthorizedError) {
          // The login expired while away. Retrying cannot fix that: stop, and let the app send the
          // user back to sign-in (see authExpired in the status).
          log.warn('VPN: Reconnect stopped, the login expired');
          this.isReconnecting = false;
          this.reconnectAttempts = 0;
          this.currentServerId = null;
          this.currentGatewayId = null;
          this.authExpired = true;
          this.notifyStatusChange();
          return;
        }
        if (!this.userInitiatedDisconnect) {
          this._attemptReconnect(serverId, gatewayId);
        }
      }
    }, delay);
  }

  /**
   * The lowest-latency active server other than the one that keeps failing, or null when none can
   * be reached. Needs the backend (the server list), so it only helps while the network is open.
   */
  async _pickFallbackServerId(excludedServerIds, token) {
    const response = await apiRelay.apiFetch(`${this.apiBaseUrl}/vpn/servers`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const list = await response.json();
    // Plain servers only: organization gateway entries repeat a node's id with a gatewayId.
    const candidates = (Array.isArray(list) ? list : [])
      .filter(s => s && s.id && s.host && !s.gatewayId && !excludedServerIds.has(s.id))
      .map(s => ({ id: s.id, host: s.host }));
    if (candidates.length === 0) return null;

    const latencies = await require('../latency').measureAll(candidates);
    let best = null;
    for (const s of candidates) {
      const ms = latencies[s.id];
      if (ms !== undefined && (best === null || ms < best.ms)) best = { id: s.id, ms };
    }
    return best ? best.id : null;
  }

  /**
   * Called once at app startup. Retries any pending-disconnect ledger entries — pure HTTP,
   * independent of Windows Service/tunnel availability.
   */
  async performStartupCleanup() {
    const owed = this._pendingDisconnectIds();
    if (owed.length > 0) {
      log.warn(`CONN_COUNTER: ${owed.length} unconfirmed /disconnect owed at launch: ${owed.map(id => this._short(id)).join(',')}`);
    }
    this.retryPendingDisconnects();
    this.logConnectionCounter('app launch');
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
        isReconnecting: this.isReconnecting,
        authExpired: this.authExpired,
        reconnectGaveUp: this.reconnectGaveUp
      };
    } catch (error) {
      // Service pipe not connected yet — return disconnected state
      return {
        status: this.isReconnecting ? 'connecting' : 'disconnected',
        session: this.currentSession,
        killSwitchEnabled: false,
        advancedKillSwitchEnabled: false,
        advancedKillSwitchActive: false,
        isReconnecting: this.isReconnecting,
        authExpired: this.authExpired,
        reconnectGaveUp: this.reconnectGaveUp
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

    const session = this.currentSession;
    this.currentSession = null;

    try {
      await serviceClient.vpnDisconnect();
    } catch (error) {
      // Service may not be available, that's ok
      // The service will clean up its own resources
    }

    // Release the slot now and wait for it: the process may exit right after this returns, and a
    // release left to a timer would only happen at the next launch (days later, for someone who
    // doesn't reopen the app), leaving the counter one too high. If the call can't complete, the
    // pending-disconnect ledger still retries it on the next launch.
    if (session?.sessionId) {
      await this.cleanupOrphanedSession(session.sessionId, 'app quit', { immediate: true });
    }

    serviceClient.disconnect();
    this.lastConnectionConfig = null;
  }
}

// Export singleton instance
module.exports = new VPNService();
