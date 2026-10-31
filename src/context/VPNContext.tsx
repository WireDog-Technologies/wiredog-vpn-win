import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { ConnectionInfo, VPNSettings, ServerLocation, User, getConnectServerId } from '@/types/vpn';
import * as api from '@/lib/api';
import { getServerById } from '@/data/servers';
import type { MeResponse, LoginOutcome } from '@/lib/api';
import { transformServer, listIdFor } from '@/lib/servers';
import { hasEntitlement, lostOrganizationAccess, organizationAccessMessage } from '@/lib/account';

interface VPNContextType {
  connection: ConnectionInfo;
  settings: VPNSettings;
  user: User | null;
  selectedServer: ServerLocation | null;
  isSwitchingServer: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  // False until the first tunnel-status read has landed, so nothing (e.g. an IP lookup) assumes
  // "disconnected" while the app was actually relaunched with the tunnel already up.
  isStatusResolved: boolean;
  isSubscriptionActive: boolean;
  advancedKillSwitchActive: boolean;
  connectionError: string | null;
  connect: (server: ServerLocation, options?: { silent?: boolean }) => Promise<void>;
  cancelConnect: () => Promise<void>;
  disconnect: (options?: { disableProtection?: boolean }) => Promise<void>;
  reconnect: () => Promise<void>;
  updateSettings: (settings: Partial<VPNSettings>) => void;
  setSelectedServer: (server: ServerLocation | null) => void;
  selectServer: (server: ServerLocation) => void;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  anonymousLogin: (accountNumber: string) => Promise<LoginOutcome>;
  verifyTwoFactor: (challengeToken: string, code: string) => Promise<void>;
  signInWithSso: (email: string) => Promise<void>;
  cancelSso: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  logout: () => void;
  clearConnectionError: () => void;
}

// Electron's ipcRenderer.invoke() wraps a rejected handler's error as
// `Error invoking remote method '<channel>': Error: <original message>` — strip that
// wrapper so the UI shows the clean message the main process actually threw.
const IPC_ERROR_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;
function extractErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(IPC_ERROR_WRAPPER, '');
}

const defaultConnection: ConnectionInfo = {
  status: 'disconnected',
  server: null,
  ipAddress: '',
  sessionStart: null,
  dataIn: 0,
  dataOut: 0,
};

const defaultSplitTunneling: VPNSettings['splitTunneling'] = {
  enabled: false,
  mode: 'exclude',
  apps: [],
  ips: [],
};

const defaultSettings: VPNSettings = {
  protocol: 'wireguard',
  killSwitch: false,
  permanentKillSwitch: false,
  autoConnect: false,
  autoReconnect: false, // No longer user-configurable; auto-reconnect is always-on when kill switch active
  reconnectToAnotherServer: true,
  splitTunneling: defaultSplitTunneling,
  ipv6Enabled: true,
  ipv6LeakProtection: true,
  blockAdsEnabled: true,
  blockMalwareEnabled: true,
};

const VPNContext = createContext<VPNContextType | undefined>(undefined);

// hasEntitlement, not a bare tier/expiry check: an organization seat can have no expiry date of
// its own, and its access is carried by /auth/me's isActive instead.
const checkSubscriptionActive = hasEntitlement;

// Map backend /me response to frontend User type
function mapMeResponseToUser(me: MeResponse): User {
  return {
    id: String(me.id),
    username: me.accountType === 'standard' ? me.displayName : undefined,
    accountNumber: me.accountNumber,
    isAnonymous: me.accountType === 'anonymous',
    subscriptionTier: (me.planTier as 'free' | 'premium' | 'elite') || (me.isActive ? 'premium' : 'free'),
    billingPeriod: me.billingPeriod,
    subscriptionStarted: me.subscriptionStartedAt ? new Date(me.subscriptionStartedAt) : undefined,
    subscriptionExpiry: me.subscriptionExpiresAt ? new Date(me.subscriptionExpiresAt) : undefined,
    isActive: me.isActive,
    totpEnabled: me.totpEnabled ?? false,
    twoFactorRequiredByOrg: me.twoFactorRequiredByOrg ?? false,
    mustChangePassword: me.mustChangePassword ?? false,
    subscriptionManagedByOrganization: me.subscriptionManagedByOrganization ?? false,
    organizationName: me.organizationName ?? undefined,
    organizationRole: me.organizationRole ?? undefined,
    organizationAccess: api.parseOrganizationAccess(me.organizationAccess),
    trialIneligibleReason: me.trialIneligibleReason,
  };
}

// How often a window-focus event may trigger a profile refresh.
const PROFILE_REFRESH_MIN_INTERVAL_MS = 15_000;
// Background refresh while signed in, so an expiry or an organization revocation is caught even
// when the window is hidden in the tray and never gets a focus event. Jittered so clients spread out.
const PROFILE_POLL_INTERVAL_MS = 5 * 60_000;
const PROFILE_POLL_JITTER_MS = 60_000;
// setTimeout silently misbehaves above 2^31-1 ms (~24.8 days); longer waits are re-armed in chunks.
const MAX_TIMER_MS = 2_147_483_647;

export const VPNProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [connection, setConnection] = useState<ConnectionInfo>(defaultConnection);
  const [settings, setSettings] = useState<VPNSettings>(defaultSettings);
  const [user, setUser] = useState<User | null>(null);
  const [selectedServer, setSelectedServer] = useState<ServerLocation | null>(null);
  // True while a server switch is tearing down the old tunnel before bringing up the new
  // one — lets the UI treat that whole disconnect-old -> connect-new sequence as one
  // continuous "in progress" state instead of flickering through the intermediate
  // connected/disconnected values connection.status genuinely passes through.
  const [isSwitchingServer, setIsSwitchingServer] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isStatusResolved, setIsStatusResolved] = useState(false);
  const [advancedKillSwitchActive, setAdvancedKillSwitchActive] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // While a kill switch is holding the network blocked (no tunnel), backend requests go through the
  // Rescue Relay first instead of waiting out a direct attempt that cannot succeed.
  useEffect(() => {
    api.setApiBlockHint(connection.status !== 'connected' && (connection.status === 'error' || advancedKillSwitchActive));
  }, [connection.status, advancedKillSwitchActive]);
  const clearConnectionError = useCallback(() => setConnectionError(null), []);

  // Load settings from electron-store on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        if (window.electronAPI?.getSettings) {
          const savedSettings = await window.electronAPI.getSettings();
          if (savedSettings) {
            // Migrate old 'openvpn' protocol to 'openvpn-udp'
            if ((savedSettings as any).protocol === 'openvpn') {
              (savedSettings as any).protocol = 'openvpn-udp';
            }
            // Migrate old splitTunneling boolean to config object
            if (typeof (savedSettings as any).splitTunneling === 'boolean') {
              (savedSettings as any).splitTunneling = {
                ...defaultSplitTunneling,
                enabled: (savedSettings as any).splitTunneling,
              };
            }
            setSettings(prev => ({ ...prev, ...savedSettings }));
          }
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    };

    // Check for existing session on mount. Only a rejected token (401) means "not signed in": a
    // network blip or a 5xx at launch is retried a few times first, so a valid session isn't
    // dropped to the login screen just because the backend was briefly unreachable.
    const checkAuth = async () => {
      try {
        const token = await window.electronAPI?.auth?.getToken?.();
        if (!token && window.electronAPI?.auth) return;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            setUser(mapMeResponseToUser(await api.fetchCurrentUser()));
            return;
          } catch (error) {
            if ((error as api.ApiError)?.status === 401 || (error as api.ApiError)?.status === 403) return;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          }
        }
      } catch {
        // Not authenticated, that's fine
      } finally {
        setIsAuthLoading(false);
      }
    };

    // Sync connection state from service (handles app restart while tunnel is active)
    const syncServiceState = async () => {
      try {
        if (window.electronAPI?.vpn?.getStatus) {
          const status = await window.electronAPI.vpn.getStatus();
          if (status?.status === 'connected' && status.session) {
            // Look up full server data by ID (boot auto-reconnect only provides server ID)
            const serverId = status.session.server?.id;
            const fullServer = serverId ? getServerById(serverId) : null;
            setConnection({
              status: 'connected',
              server: fullServer || status.session.server || null,
              ipAddress: status.session.publicIp || '',
              sessionStart: status.session.connectedAt ? new Date(status.session.connectedAt) : new Date(),
              dataIn: 0,
              dataOut: 0,
            });
          } else if (status?.status === 'error') {
            setConnection(prev => ({ ...prev, status: 'connecting' }));
          }
          // Sync advanced kill switch state
          if (status?.advancedKillSwitchActive !== undefined) {
            setAdvancedKillSwitchActive(status.advancedKillSwitchActive);
          }
          if (status?.advancedKillSwitchEnabled !== undefined) {
            setSettings(prev => ({ ...prev, permanentKillSwitch: status.advancedKillSwitchEnabled! }));
          }
        }
      } catch {
        // Service not available, that's fine
      }
    };

    loadSettings();
    checkAuth();
    syncServiceState();

    // Retry sync after service pipe has time to connect (boot auto-reconnect scenario:
    // service is already connected but pipe isn't ready when renderer first mounts)
    const retryTimer = setTimeout(syncServiceState, 3000);
    return () => clearTimeout(retryTimer);
  }, []);

  // Forces a clean logout when the backend has rejected the auth token (expired or
  // invalid). Clears the local session only; there's no point calling the authenticated
  // /auth/logout endpoint with a token the backend has already rejected. Clearing `user`
  // routes back to the login screen via the existing isAuthenticated-gated routing in App.tsx.
  const handleUnauthorized = useCallback(async () => {
    await window.electronAPI?.auth?.clearToken?.();
    setUser(null);
    setConnectionError('Your session has expired. Please sign in again.');
  }, []);

  const connect = useCallback(async (server: ServerLocation, options?: { silent?: boolean }) => {
    setConnectionError(null);

    if (!checkSubscriptionActive(user)) {
      // An organization used to cover this account and no longer does: say so, rather than
      // implying a personal plan would fix an employer-side problem.
      const lost = lostOrganizationAccess(user);
      const error = new Error(lost ? organizationAccessMessage(lost) : 'An active subscription is required to connect.');
      if (!options?.silent) setConnectionError(error.message);
      throw error;
    }

    setConnection(prev => ({ ...prev, status: 'connecting', server }));

    try {
      // Check if running in Electron with VPN support
      if (window.electronAPI?.vpn) {
        // Real Electron VPN connection
        // A gateway entry's list id is composite; the backend takes the node's real id plus the
        // gateway (named Dedicated IP) separately.
        const result = await window.electronAPI.vpn.connect(getConnectServerId(server), settings, server.gatewayId);
        setConnection({
          status: 'connected',
          server,
          // The exit IP the backend assigned (shared pool or Dedicated IP). No fallback to the VPN
          // server's own address: that is not what websites see. Empty shows as "Unknown".
          ipAddress: result.publicIp || '',
          sessionStart: new Date(result.connectedAt),
          dataIn: 0,
          dataOut: 0,
        });
      } else {
        // Mock for browser development
        await new Promise(resolve => setTimeout(resolve, 1500));
        const randomIP = `10.0.0.${Math.floor(Math.random() * 254) + 2}`;
        setConnection({
          status: 'connected',
          server,
          ipAddress: randomIP,
          sessionStart: new Date(),
          dataIn: 0,
          dataOut: 0,
        });
      }
    } catch (error) {
      setConnection(defaultConnection);
      const message = extractErrorMessage(error, 'Failed to connect to VPN.');
      // Substring match, not exact equality: ConnectCancelledError/UnauthorizedError set a
      // custom .name, and Electron's IPC error serialization includes that name in the
      // wrapped message (e.g. "...: ConnectCancelledError: Connection cancelled") rather than
      // the plain "Error:" prefix IPC_ERROR_WRAPPER strips — an exact-match check would miss
      // it and fall through to showing this expected, non-error case as an error toast.
      if (message.includes('Connection cancelled')) {
        // User-initiated cancel (tap-again-to-cancel) — expected, not a failure. No error toast.
        return;
      }
      if (message.includes('WIREDOG_UNAUTHORIZED')) {
        // Token expired/invalid — force a clean logout instead of leaving the user stuck
        // on a raw "Invalid token" toast while still shown as signed in.
        console.warn('VPN connection failed: session expired, logging out');
        await handleUnauthorized();
        return;
      }
      console.error('VPN connection failed:', error);
      if (!options?.silent) {
        setConnectionError(message);
      }
      throw error;
    }
  }, [settings, user, handleUnauthorized]);

  /** Cancels an in-flight connect attempt — a first attempt or an in-progress auto-reconnect. */
  const cancelConnect = useCallback(async () => {
    if (connection.status !== 'connecting') return;
    if (window.electronAPI?.vpn?.cancelConnect) {
      await window.electronAPI.vpn.cancelConnect();
    }
  }, [connection.status]);

  const disconnect = useCallback(async (options?: { disableProtection?: boolean }) => {
    setConnection(prev => ({ ...prev, status: 'connecting' }));

    try {
      if (window.electronAPI?.vpn) {
        await window.electronAPI.vpn.disconnect(options);
      } else {
        // Mock for browser development
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      setConnection(defaultConnection);
    } catch (error) {
      console.error('VPN disconnect failed:', error);
      setConnection(defaultConnection);
    }
  }, []);

  const reconnect = useCallback(async () => {
    const currentServer = connection.server;
    if (!currentServer) return;
    try {
      await disconnect();
      // Small delay to let tunnel tear down
      await new Promise(resolve => setTimeout(resolve, 500));
      await connect(currentServer);
    } catch (error) {
      console.error('VPN reconnect failed:', error);
    }
  }, [connection.server, disconnect, connect]);

  // Ref mirrors connection.status synchronously so switchServer's wait-loop below can poll
  // the latest value without depending on a stale closure.
  const connectionStatusRef = useRef(connection.status);
  useEffect(() => {
    connectionStatusRef.current = connection.status;
  }, [connection.status]);

  // Waits for connection.status to settle at 'disconnected' (e.g. after a server-switch
  // disconnect), bounded by a timeout so a stuck tunnel teardown can't hang forever.
  const waitForDisconnected = useCallback((timeoutMs = 8000): Promise<boolean> => {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        if (connectionStatusRef.current === 'disconnected') {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }, []);

  // Tears down whatever's currently active and connects to `server` — the actual
  // disconnect-old-then-connect-new sequence behind quick server switching.
  const switchServer = useCallback(async (server: ServerLocation) => {
    setIsSwitchingServer(true);
    try {
      if (connection.status === 'connecting') {
        await cancelConnect();
      } else if (connection.status === 'connected' || connection.status === 'error') {
        // Keep Always-On protection active through the switch rather than dropping to fully
        // disabled — matches the "Stay Protected" choice a manual disconnect would prompt for.
        await disconnect({ disableProtection: !settings.permanentKillSwitch });
      }

      const settled = await waitForDisconnected();
      if (!settled) {
        setConnectionError('Unable to switch servers. Please try again.');
        return;
      }

      await connect(server);
    } finally {
      setIsSwitchingServer(false);
    }
  }, [connection.status, settings.permanentKillSwitch, cancelConnect, disconnect, connect, waitForDisconnected]);

  // Selecting a server while connected/connecting/in an error state immediately switches to
  // it — no separate disconnect step required. Selecting while disconnected just updates the
  // highlight, same as before; the user still hits Connect for that one.
  const selectServer = useCallback((server: ServerLocation) => {
    const isSameServer = server.id === selectedServer?.id;
    setSelectedServer(server);

    const isActive = connection.status === 'connected' || connection.status === 'connecting' || connection.status === 'error';
    if (isActive && !isSameServer) {
      switchServer(server);
    }
  }, [selectedServer, connection.status, switchServer]);

  // Listen for VPN status changes from Electron
  useEffect(() => {
    if (window.electronAPI?.vpn) {
      // Note: Do NOT sync killSwitchEnabled from backend — that reflects runtime WFP filter state,
      // not the user's preference. The setting persists in electron-store and is sent on connect.
      const applyStatus = (status: any) => {
        // The login expired while the app was away and its reconnect could not continue: go back to
        // sign-in with the usual message instead of leaving a dead tunnel on screen.
        if (status.authExpired) {
          handleUnauthorized();
          return;
        }
        if (status.advancedKillSwitchActive !== undefined) {
          setAdvancedKillSwitchActive(status.advancedKillSwitchActive);
        }
        if (status.advancedKillSwitchEnabled !== undefined) {
          setSettings(prev => ({ ...prev, permanentKillSwitch: status.advancedKillSwitchEnabled! }));
        }

        // Sync connection state based on status
        if (status.status === 'connected' && status.session) {
          // Smart merge: preserve full server data from connect(), only update IP from backend
          // Look up full server data by ID for boot auto-reconnect scenarios
          const serverId = status.session!.server?.id;
          const lookedUp = serverId ? getServerById(serverId) : null;
          // A gateway (named Dedicated IP) session keeps its gateway id so the UI can label it.
          const fullServer = lookedUp && status.session!.gatewayId
            ? { ...lookedUp, gatewayId: status.session!.gatewayId }
            : lookedUp;
          setConnection(prev => ({
            status: 'connected',
            // Keep the server the user picked, unless the session is really on a different one (an
            // automatic move to another server after the first one failed): then show the new one.
            server: prev.server && (!serverId || prev.server.id === serverId)
              ? prev.server
              : (fullServer || status.session!.server),
            ipAddress: status.session!.publicIp || prev.ipAddress || '',
            sessionStart: prev.sessionStart || (status.session!.connectedAt ? new Date(status.session!.connectedAt) : null),
            dataIn: prev.dataIn,
            dataOut: prev.dataOut,
          }));
        } else if (status.status === 'connecting') {
          // Connecting - update status but keep existing server info
          setConnection(prev => ({
            ...prev,
            status: 'connecting'
          }));
        } else if (status.status === 'error') {
          // Connection lost - keep server info but show error state
          setConnection(prev => ({
            ...prev,
            status: 'error'
          }));
        } else if (status.status === 'disconnected') {
          // Disconnected - reset to default, but NOT if we're currently connecting.
          // During PersistentBlock → Bootstrap transition, the service briefly reports
          // "disconnected" before the connection proceeds. Resetting here would cause
          // the UI to flicker back to UNPROTECTED.
          setConnection(prev => {
            // ...unless the auto-reconnect loop has really given up: then there is nothing left to wait for.
            if (prev.status === 'connecting' && !status.reconnectGaveUp) return prev;
            return defaultConnection;
          });
          if (status.reconnectGaveUp) {
            setConnectionError("Couldn't reconnect to WireDog VPN. Check your connection or choose another server.");
          }
        }
      };

      const unsubscribe = window.electronAPI.vpn.onStatusChange((status) => {
        setIsStatusResolved(true);
        applyStatus(status);
      });

      // Read the current tunnel state once up front. The app can be relaunched with the tunnel
      // already up; until this lands, "disconnected" is only the default, not a fact.
      window.electronAPI.vpn.getStatus()
        .then(status => {
          if (status) applyStatus(status);
        })
        .catch(error => console.warn('Failed to read initial VPN status:', error))
        .finally(() => setIsStatusResolved(true));

      return unsubscribe;
    }
    setIsStatusResolved(true);
  }, []);

  // Auto-connect on app startup (autoConnect setting or advancedKillSwitchActive). Keyed on the
  // account id (not the profile object), so a routine profile refresh never re-triggers it, and
  // guarded so it runs once per signed-in account.
  const autoConnectedForRef = useRef<string | null>(null);
  useEffect(() => {
    const attemptAutoConnect = async () => {
      // Only proceed if authenticated, not loading, and disconnected
      if (!user || isAuthLoading || !isStatusResolved || connection.status !== 'disconnected') return;
      if (!window.electronAPI?.vpn) return;

      const shouldAutoConnect = settings.autoConnect;
      const shouldAutoReconnect = advancedKillSwitchActive;

      if (!shouldAutoConnect && !shouldAutoReconnect) return;
      if (autoConnectedForRef.current === user.id) return;
      autoConnectedForRef.current = user.id;

      try {
        const savedSettings = await window.electronAPI.getSettings();
        const lastServerId = savedSettings?.lastServerId as string | undefined;
        if (!lastServerId) return;
        const lastGatewayId = savedSettings?.lastGatewayId as number | undefined;

        // Look the server up in the live list (it carries organization gateway entries too);
        // the static list is only a fallback for when the backend can't be reached.
        const wantedId = listIdFor(lastServerId, lastGatewayId);
        let server: ServerLocation | undefined;
        try {
          server = (await api.getServers()).map(transformServer).find(s => s.id === wantedId);
        } catch {
          // fall through to the static list
        }
        server = server ?? getServerById(lastServerId);
        if (!server) return;

        // Small delay to let UI settle
        await new Promise(resolve => setTimeout(resolve, 500));

        await connect(server, { silent: true });
      } catch (error) {
        console.error('Auto-connect failed:', error);
        // Silently fail - don't interrupt user
      }
    };

    attemptAutoConnect();
  }, [user?.id, isAuthLoading, isStatusResolved, advancedKillSwitchActive]);

  const updateSettings = useCallback((newSettings: Partial<VPNSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };

      // If standard kill switch is being disabled, also disable permanent kill switch
      if (newSettings.killSwitch === false && prev.permanentKillSwitch) {
        updated.permanentKillSwitch = false;
        newSettings = { ...newSettings, permanentKillSwitch: false };
      }

      // Persist to electron-store
      if (window.electronAPI?.setSettings) {
        window.electronAPI.setSettings(newSettings).catch((error: Error) => {
          console.error('Failed to save settings:', error);
        });
      }

      // If kill switch changed and VPN is connected, apply immediately
      if (newSettings.killSwitch !== undefined && connection.status === 'connected') {
        if (window.electronAPI?.vpn?.toggleKillSwitch) {
          window.electronAPI.vpn.toggleKillSwitch(newSettings.killSwitch).catch((error: Error) => {
            console.error('Failed to toggle kill switch:', error);
          });
        }
      }

      // If permanent kill switch changed, notify service
      if (newSettings.permanentKillSwitch !== undefined) {
        if (newSettings.permanentKillSwitch) {
          window.electronAPI?.vpn?.enableAdvancedKillSwitch().catch((error: Error) => {
            console.error('Failed to enable advanced kill switch:', error);
          });
        } else {
          window.electronAPI?.vpn?.disableAdvancedKillSwitch().catch((error: Error) => {
            console.error('Failed to disable advanced kill switch:', error);
          });
        }
      }

      return updated;
    });
  }, [connection.status]);

  // Loads the profile for a freshly signed-in session. Throws if it can't, so the caller shows an
  // error instead of silently sitting on the login screen.
  const loadProfileAfterSignIn = useCallback(async () => {
    setUser(mapMeResponseToUser(await api.fetchCurrentUser()));
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<LoginOutcome> => {
    const outcome = await api.login(email, password);
    if (outcome.status === 'signedIn') await loadProfileAfterSignIn();
    return outcome;
  }, [loadProfileAfterSignIn]);

  const anonymousLogin = useCallback(async (accountNumber: string): Promise<LoginOutcome> => {
    const outcome = await api.anonymousLogin(accountNumber);
    if (outcome.status === 'signedIn') await loadProfileAfterSignIn();
    return outcome;
  }, [loadProfileAfterSignIn]);

  /** Second step of a login that returned 'twoFactorRequired'. */
  const verifyTwoFactor = useCallback(async (challengeToken: string, code: string) => {
    await api.verifyTwoFactor(challengeToken, code);
    await loadProfileAfterSignIn();
  }, [loadProfileAfterSignIn]);

  /**
   * Runs the whole native SSO flow: browser sign-in at the org's IdP (resolved by the
   * wiredog://sso callback), then exchanges the one-time code (bound to a PKCE verifier only the
   * main process holds) for a session.
   */
  const signInWithSso = useCallback(async (email: string) => {
    const trimmed = email.trim();
    const domain = trimmed.split('@').pop()?.toLowerCase();
    if (!domain || !window.electronAPI?.sso || !(await api.ssoAvailable(trimmed))) {
      throw new Error('SSO_NOT_AVAILABLE');
    }
    const { code, codeVerifier } = await window.electronAPI.sso.authenticate(domain);
    await api.exchangeSsoCode(code, codeVerifier);
    await loadProfileAfterSignIn();
  }, [loadProfileAfterSignIn]);

  const cancelSso = useCallback(async () => {
    await window.electronAPI?.sso?.cancel();
  }, []);

  /** Replaces a temporary password; the backend clears mustChangePassword. */
  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await api.changePassword(currentPassword, newPassword);
    await loadProfileAfterSignIn();
  }, [loadProfileAfterSignIn]);

  // Re-reads the profile. Only a rejected token signs the user out: if the backend is briefly
  // unreachable the session is kept and the last-known profile stays.
  const refreshInFlightRef = useRef(false);
  const lastRefreshRef = useRef(0);
  const refreshUser = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const me = await api.fetchCurrentUser();
      lastRefreshRef.current = Date.now();
      setUser(mapMeResponseToUser(me));
    } catch (error) {
      if ((error as api.ApiError)?.status === 401) {
        await handleUnauthorized();
      } else {
        console.warn('Profile refresh failed, keeping session:', error);
      }
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [handleUnauthorized]);

  // Keep the profile in step with the account when the user comes back to the window (e.g. after
  // setting up 2FA or paying on the website). Throttled so focus flapping doesn't hammer /auth/me.
  const isSignedIn = !!user;
  useEffect(() => {
    if (!isSignedIn) return;
    const onFocus = () => {
      if (Date.now() - lastRefreshRef.current >= PROFILE_REFRESH_MIN_INTERVAL_MS) {
        refreshUser();
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isSignedIn, refreshUser]);

  // Periodic refresh while signed in (see PROFILE_POLL_INTERVAL_MS).
  useEffect(() => {
    if (!isSignedIn) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(async () => {
        await refreshUser();
        schedule();
      }, PROFILE_POLL_INTERVAL_MS + (Math.random() * 2 - 1) * PROFILE_POLL_JITTER_MS);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [isSignedIn, refreshUser]);

  // A personal subscription's end date passes on its own, with no event and no refresh to notice
  // it. Wake up at the exact moment it lapses: re-read the profile (the backend is the authority,
  // e.g. a renewal that just went through) and bump a tick so entitlement is re-evaluated against
  // the clock below. Organization seats carry entitlement in isActive instead, so they have no
  // date to wait for.
  const [expiryTick, setExpiryTick] = useState(0);
  const expiryMs = user && !user.subscriptionManagedByOrganization ? user.subscriptionExpiry?.getTime() : undefined;
  useEffect(() => {
    if (expiryMs === undefined) return;
    const remaining = expiryMs - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      setExpiryTick(tick => tick + 1);
      // Only the final wake-up needs the profile re-read; a chunked wait just re-arms.
      if (remaining <= MAX_TIMER_MS) refreshUser();
    }, Math.min(remaining, MAX_TIMER_MS) + 500);
    return () => clearTimeout(timer);
  }, [expiryMs, expiryTick, refreshUser]);

  // A tunnel that is already up outlives the connect-time subscription check, so every profile
  // refresh (and the expiry wake-up above) re-checks entitlement and tears the tunnel down if it
  // has lapsed.
  const entitlementTeardownRef = useRef(false);
  useEffect(() => {
    if (connection.status === 'disconnected') {
      entitlementTeardownRef.current = false;
      return;
    }
    if (!user || checkSubscriptionActive(user) || entitlementTeardownRef.current) return;
    entitlementTeardownRef.current = true;
    console.warn('Subscription no longer active, disconnecting tunnel');
    const lost = lostOrganizationAccess(user);
    setConnectionError(lost ? organizationAccessMessage(lost) : 'Your subscription is no longer active.');
    disconnect({ disableProtection: !settings.permanentKillSwitch });
  }, [user, connection.status, expiryTick]);

  const logout = useCallback(async () => {
    if (connection.status !== 'disconnected') {
      throw new Error('Please disconnect the VPN before signing out.');
    }
    await api.logout();
    setUser(null);
  }, [connection.status]);

  return (
    <VPNContext.Provider
      value={{
        connection,
        settings,
        user,
        selectedServer,
        isSwitchingServer,
        isAuthenticated: !!user,
        isAuthLoading,
        isStatusResolved,
        isSubscriptionActive: checkSubscriptionActive(user),
        advancedKillSwitchActive,
        connectionError,
        connect,
        cancelConnect,
        disconnect,
        reconnect,
        updateSettings,
        setSelectedServer,
        selectServer,
        login,
        anonymousLogin,
        verifyTwoFactor,
        signInWithSso,
        cancelSso,
        changePassword,
        refreshUser,
        logout,
        clearConnectionError,
      }}
    >
      {children}
    </VPNContext.Provider>
  );
};

export const useVPN = () => {
  const context = useContext(VPNContext);
  if (!context) {
    throw new Error('useVPN must be used within a VPNProvider');
  }
  return context;
};
