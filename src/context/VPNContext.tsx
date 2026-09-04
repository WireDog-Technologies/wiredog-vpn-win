import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { ConnectionInfo, VPNSettings, ServerLocation, User } from '@/types/vpn';
import * as api from '@/lib/api';
import { getServerById } from '@/data/servers';
import type { MeResponse } from '@/lib/api';

interface VPNContextType {
  connection: ConnectionInfo;
  settings: VPNSettings;
  user: User | null;
  selectedServer: ServerLocation | null;
  isSwitchingServer: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
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
  login: (email: string, password: string) => Promise<void>;
  anonymousLogin: (accountNumber: string) => Promise<void>;
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
  splitTunneling: defaultSplitTunneling,
  ipv6Enabled: true,
  ipv6LeakProtection: true,
  blockAdsEnabled: true,
  blockMalwareEnabled: true,
};

const VPNContext = createContext<VPNContextType | undefined>(undefined);

function checkSubscriptionActive(user: User | null): boolean {
  if (!user) return false;
  if (user.subscriptionTier === 'free') return false;
  if (user.subscriptionExpiry && user.subscriptionExpiry < new Date()) return false;
  return true;
}

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
  };
}

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
  const [advancedKillSwitchActive, setAdvancedKillSwitchActive] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
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

    // Check for existing session on mount
    const checkAuth = async () => {
      try {
        const me = await api.getCurrentUser();
        if (me) {
          setUser(mapMeResponseToUser(me));
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
              ipAddress: status.session.server?.exitIp || status.session.assignedIp || status.session.server?.ipAddress || '',
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
      const error = new Error('An active subscription is required to connect.');
      if (!options?.silent) setConnectionError(error.message);
      throw error;
    }

    setConnection(prev => ({ ...prev, status: 'connecting', server }));

    try {
      // Check if running in Electron with VPN support
      if (window.electronAPI?.vpn) {
        // Real Electron VPN connection
        const result = await window.electronAPI.vpn.connect(server.id, settings);
        setConnection({
          status: 'connected',
          server,
          ipAddress: result.server?.exitIp || result.assignedIp || result.server?.ipAddress,
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
      const unsubscribe = window.electronAPI.vpn.onStatusChange((status) => {
        // Note: Do NOT sync killSwitchEnabled from backend — that reflects runtime WFP filter state,
        // not the user's preference. The setting persists in electron-store and is sent on connect.
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
          const fullServer = serverId ? getServerById(serverId) : null;
          setConnection(prev => ({
            status: 'connected',
            server: prev.server || fullServer || status.session!.server,
            ipAddress: prev.ipAddress || status.session!.server?.exitIp || status.session!.assignedIp || status.session!.server?.ipAddress || '',
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
            if (prev.status === 'connecting') return prev;
            return defaultConnection;
          });
        }
      });
      return unsubscribe;
    }
  }, []);

  // Auto-connect on app startup (autoConnect setting or advancedKillSwitchActive)
  useEffect(() => {
    const attemptAutoConnect = async () => {
      // Only proceed if authenticated, not loading, and disconnected
      if (!user || isAuthLoading || connection.status !== 'disconnected') return;
      if (!window.electronAPI?.vpn) return;

      const shouldAutoConnect = settings.autoConnect;
      const shouldAutoReconnect = advancedKillSwitchActive;

      if (!shouldAutoConnect && !shouldAutoReconnect) return;

      try {
        const savedSettings = await window.electronAPI.getSettings();
        const lastServerId = savedSettings?.lastServerId;
        if (!lastServerId) return;

        const server = getServerById(lastServerId);
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
  }, [user, isAuthLoading, advancedKillSwitchActive]);

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

  const login = useCallback(async (email: string, password: string) => {
    await api.login(email, password);
    const me = await api.getCurrentUser();
    if (me) setUser(mapMeResponseToUser(me));
  }, []);

  const anonymousLogin = useCallback(async (accountNumber: string) => {
    await api.anonymousLogin(accountNumber);
    const me = await api.getCurrentUser();
    if (me) setUser(mapMeResponseToUser(me));
  }, []);

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
