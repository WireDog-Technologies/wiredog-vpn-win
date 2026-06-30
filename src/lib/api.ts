// Production URL is the default; development falls back to localhost
const API_URL = import.meta.env.MODE === 'development'
  ? (import.meta.env.VITE_API_URL || 'http://localhost:3001/api')
  : (import.meta.env.VITE_API_URL || 'https://api.wiredogvpn.com/api');

const FETCH_TIMEOUT_MS = 15_000;

interface ApiError {
  message: string;
  status: number;
}

// Response from /api/auth/me
interface MeResponse {
  id: number;
  accountNumber: string;
  accountType: 'standard' | 'anonymous';
  displayName: string;
  isActive: boolean;
  planTier?: string;
  billingPeriod?: string;
  subscriptionExpiresAt?: string;
  subscriptionStartedAt?: string;
}

async function getAuthToken(): Promise<string | null> {
  try {
    if (window.electronAPI?.auth?.getToken) {
      return await window.electronAPI.auth.getToken();
    }
  } catch {
    // No token available
  }
  return null;
}

async function getHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = await getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw { message: error.error || 'Request failed', status: response.status } as ApiError;
  }
  return response.json();
}

export async function login(email: string, password: string): Promise<void> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await handleResponse<{ token?: string }>(response);

  // Store token in Electron app if available
  if (data.token && window.electronAPI?.auth?.setToken) {
    await window.electronAPI.auth.setToken(data.token);
  }
}

export async function anonymousLogin(accountNumber: string): Promise<void> {
  // Strip spaces from account number
  const cleanNumber = accountNumber.replace(/\s/g, '');
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ identifier: cleanNumber }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await handleResponse<{ token?: string }>(response);

  // Store token in Electron app if available
  if (data.token && window.electronAPI?.auth?.setToken) {
    await window.electronAPI.auth.setToken(data.token);
  }
}

export async function logout(): Promise<void> {
  const headers = await getHeaders();
  await fetch(`${API_URL}/auth/logout`, {
    method: 'POST',
    headers,
    credentials: 'include',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  // Clear token from Electron app
  if (window.electronAPI?.auth?.clearToken) {
    await window.electronAPI.auth.clearToken();
  }
}

export async function registerStandard(email: string, password: string, referralCode?: string): Promise<void> {
  const body: Record<string, string> = { email, password };
  if (referralCode) body.referralCode = referralCode;
  const response = await fetch(`${API_URL}/auth/register/standard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await handleResponse<unknown>(response);
}

export async function registerAnonymous(): Promise<string> {
  const response = await fetch(`${API_URL}/auth/register/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await handleResponse<{ accountNumber: string }>(response);
  return data.accountNumber;
}

export async function getCurrentUser(): Promise<MeResponse | null> {
  try {
    const headers = await getHeaders();
    const response = await fetch(`${API_URL}/auth/me`, {
      method: 'GET',
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await handleResponse<MeResponse>(response);
  } catch {
    return null;
  }
}

// VPN Server response from backend
export interface ServerResponse {
  id: string;
  state: string;
  stateCode: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  isRecommended: boolean;
  latency: number;
  load: number;
  host: string;
}

export async function getServers(): Promise<ServerResponse[]> {
  const headers = await getHeaders();
  const response = await fetch(`${API_URL}/vpn/servers`, {
    method: 'GET',
    headers,
    credentials: 'include',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return handleResponse<ServerResponse[]>(response);
}

export interface ReportIssuePayload {
  username?: string;
  email: string;
  os: string;
  osVersion: string;
  vpnVersion: string;
  subject: string;
  message: string;
}

export async function reportIssue(payload: ReportIssuePayload): Promise<void> {
  const headers = await getHeaders();
  const response = await fetch(`${API_URL}/support/report-issue`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await handleResponse<{ success: boolean }>(response);
}

// App update policy types
export interface PlatformPolicy {
  minSupportedVersion: number;
  latestVersion: number;
  forceUpdate: boolean;
  maintenanceMode: boolean;
  updateMessage: string | null;
  downloadUrl: string | null;
}

export interface AppConfigResponse {
  timestamp: string;
  maintenanceMode: boolean;
  platforms: Record<string, PlatformPolicy>;
}

export async function getAppConfig(): Promise<AppConfigResponse> {
  const response = await fetch(`${API_URL}/app/config`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return handleResponse<AppConfigResponse>(response);
}

export type { MeResponse, ApiError };
