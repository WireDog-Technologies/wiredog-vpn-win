export type Protocol = 'wireguard' | 'openvpn-udp' | 'openvpn-tcp' | 'ikev2';

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

export interface ServerLocation {
  id: string;
  state: string;
  stateCode: string;
  city: string;
  latitude: number;
  longitude: number;
  latency: number;
  load: number;
  recommended?: boolean;
  host: string;
  // Organization gateway entry (a named Dedicated IP). Undefined for a normal server.
  gatewayId?: number;
  gatewayName?: string;
  // The node's real server id when `id` is the composite "<serverId>_gw<gatewayId>" list id.
  apiServerId?: string;
}

/** What /vpn/connect takes as `serverId`. For a gateway entry `id` is a composite list id. */
export const getConnectServerId = (server: ServerLocation): string => server.apiServerId ?? server.id;

export const isDedicatedServer = (server: ServerLocation | null | undefined): boolean =>
  server?.gatewayId !== undefined && server?.gatewayId !== null;

export interface ConnectionInfo {
  status: ConnectionStatus;
  server: ServerLocation | null;
  ipAddress: string;
  sessionStart: Date | null;
  dataIn: number;
  dataOut: number;
}

export type SplitTunnelMode = 'include' | 'exclude';

export interface SplitTunnelApp {
  name: string;
  exePath: string;
  icon?: string;
}

export interface SplitTunnelingConfig {
  enabled: boolean;
  mode: SplitTunnelMode;
  apps: SplitTunnelApp[];
  ips: string[];
}

export interface VPNSettings {
  protocol: Protocol;
  killSwitch: boolean;
  permanentKillSwitch: boolean;
  autoConnect: boolean;
  autoReconnect: boolean;
  // When the current server keeps failing to reconnect, connect to the fastest other server instead.
  // On by default; the user can turn it off, since the location they appear in changes.
  reconnectToAnotherServer: boolean;
  splitTunneling: SplitTunnelingConfig;
  ipv6Enabled?: boolean;
  ipv6LeakProtection?: boolean;
  // Guardian Mode — DNS-level ad/malware blocking, resolved server-side per connection
  // (see resolveDnsAddresses in the backend's vpn.ts) based on these two flags sent with
  // every /vpn/connect request.
  blockAdsEnabled?: boolean;
  blockMalwareEnabled?: boolean;
}

// Where the account stands with an organization. 'inactive': the org's own subscription lapsed
// (the seat is intact). 'revoked': an admin removed this person. Unknown values decode as 'active'.
export type OrganizationAccess = 'active' | 'inactive' | 'revoked';

export interface User {
  id: string;
  username?: string;
  accountNumber?: string;
  isAnonymous: boolean;
  subscriptionTier: 'free' | 'premium' | 'elite';
  billingPeriod?: string;
  subscriptionStarted?: Date;
  subscriptionExpiry?: Date;
  // /auth/me isActive. For an organization seat this is what carries entitlement, since the
  // seat can have no expiry date of its own.
  isActive: boolean;
  // Business / organization state, all from /auth/me.
  totpEnabled: boolean;
  twoFactorRequiredByOrg: boolean;
  mustChangePassword: boolean;
  subscriptionManagedByOrganization: boolean;
  organizationName?: string;
  organizationRole?: string;
  organizationAccess?: OrganizationAccess;
  // From /auth/me: why the account cannot start a free trial, or null when it can. Undefined when
  // the backend does not say, which the app treats as 'show nothing'.
  trialIneligibleReason?: string | null;
}

// Currently published Privacy Policy / Terms of Service versions. Opaque strings, only compared
// for equality against what the user last accepted.
export interface LegalVersions {
  privacyVersion: string;
  termsVersion: string;
  summary?: string | null;
}

// Electron VPN API types
export interface VPNConnectionResult {
  sessionId: number;
  assignedIp: string;
  // Backend-assigned per-session SNAT exit IP (shared pool or Dedicated IP) â€” this is what
  // external services actually see once the tunnel is active. server.ipAddress below is the
  // VPN server's own address, not what the user's traffic appears to come from.
  publicIp?: string;
  // The organization gateway (named Dedicated IP) this session uses, if any.
  gatewayId?: number | null;
  connectedAt: string;
  server: {
    id?: string;
    city: string;
    stateCode: string;
    ipAddress: string;
    exitIp?: string;
  };
}

export interface VPNStatusUpdate {
  status: ConnectionStatus;
  session: VPNConnectionResult | null;
  killSwitchEnabled: boolean;
  advancedKillSwitchEnabled?: boolean;
  advancedKillSwitchActive?: boolean;
  isReconnecting?: boolean;
  // The auto-reconnect loop used up all its attempts: the UI should stop showing 'connecting'.
  reconnectGaveUp?: boolean;
}

export interface VPNStats {
  bytesReceived: string;
  bytesSent: string;
}

// Extend Window interface for Electron API
declare global {
  interface Window {
    electronAPI?: {
      vpn: {
        connect: (serverId: string, settings: VPNSettings, gatewayId?: number) => Promise<VPNConnectionResult>;
        cancelConnect: () => Promise<{ success: boolean }>;
        disconnect: (options?: { disableProtection?: boolean }) => Promise<{ success: boolean }>;
        getStatus: () => Promise<VPNStatusUpdate>;
        getStats: () => Promise<VPNStats | null>;
        toggleKillSwitch?: (enabled: boolean) => Promise<void>;
        enableAdvancedKillSwitch: () => Promise<{ success: boolean }>;
        disableAdvancedKillSwitch: () => Promise<{ success: boolean }>;
        emergencyReset: () => Promise<{ success: boolean }>;
        onStatusChange: (callback: (status: VPNStatusUpdate) => void) => () => void;
      };
      // Window controls
      minimizeWindow: () => Promise<void>;
      maximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      quitApp: () => Promise<void>;
      getAppVersion: () => Promise<string>;
      isWindowMaximized: () => Promise<boolean>;
      safeReload: () => Promise<void>;
      // System
      openExternal: (url: string) => Promise<boolean>;
      // Latency measurement
      // Resolves to {} (and measures nothing) while the tunnel is up or coming up: probes made
      // then are routed through the connected server and come back inflated.
      measureLatency: (servers: Array<{ id: string; host: string }>) => Promise<Record<string, number>>;
      relayRequest: (request: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string | null;
      }) => Promise<{
        ok: boolean;
        status?: number;
        statusText?: string;
        headers?: Record<string, string | string[]>;
        bodyBase64?: string;
      }>;
      // Business SSO: opens the browser to the organization's identity provider and resolves with
      // the one-time code (bound to a PKCE verifier only the main process holds) once the
      // wiredog://sso callback arrives. Rejects with 'SSO_CANCELLED' | 'SSO_NO_ACCOUNT' | 'SSO_FAILED'.
      sso: {
        authenticate: (domain: string) => Promise<{ code: string; codeVerifier: string }>;
        cancel: () => Promise<void>;
      };
      // Published Privacy Policy / Terms of Service versions from /app/config (null if unavailable).
      getLegalConfig: () => Promise<LegalVersions | null>;
      // Split tunneling
      getInstalledApps: () => Promise<SplitTunnelApp[]>;
      browseForApp: () => Promise<SplitTunnelApp | null>;
      // Settings
      getSettings: () => Promise<Record<string, unknown>>;
      setSettings: (settings: Record<string, unknown>) => Promise<boolean>;
      setAutoLaunch: (enabled: boolean, mode: 'open' | 'minimize') => Promise<{ success: boolean; error?: string }>;
      // System info
      getOsVersion: () => Promise<string>;
      getGeolocation: () => Promise<{ ip: string; city: string; region: string; country: string }>;
      // Logs
      logs: {
        openAppLogs: () => Promise<void>;
        openServiceLogs: () => Promise<void>;
      };
      // Compact window
      compact: {
        showMain: () => Promise<void>;
        exit: () => Promise<void>;
      };
      // Auth token management
      auth: {
        setToken: (token: string) => Promise<{ success: boolean; error?: string }>;
        getToken: () => Promise<string | null>;
        clearToken: () => Promise<{ success: boolean; error?: string }>;
      };
      // Update operations
      update: {
        signalReady: () => Promise<void>;
        checkForUpdates: () => Promise<{ upToDate: boolean }>;
        downloadUpdate: () => Promise<void>;
        installUpdate: () => void;
        onAvailable: (callback: (data: { message: string | null; downloadUrl: string | null; latestVersion: number }) => void) => () => void;
        onDownloaded: (callback: () => void) => () => void;
        onForceRequired: (callback: (data: { message: string | null; downloadUrl: string | null }) => void) => () => void;
        onMaintenance: (callback: (data: { message: string | null }) => void) => () => void;
        onDownloadProgress: (callback: (data: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => () => void;
      };
      // Platform
      platform: string;
      isMac: boolean;
      isWindows: boolean;
      isLinux: boolean;
      isDev: boolean;
    };
  }
}
