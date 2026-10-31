import type { Announcement } from '@/types/announcements';

// Production URL is the default; development falls back to localhost
const API_URL = import.meta.env.MODE === 'development'
  ? (import.meta.env.VITE_API_URL || 'http://localhost:3001/api')
  : (import.meta.env.VITE_API_URL || 'https://api.wiredogvpn.com/api');

const FETCH_TIMEOUT_MS = 15_000;

// --- Rescue Relay -------------------------------------------------------------------------------
// While a kill switch blocks the network, a direct request to the backend cannot get through. The main
// process can reach it through the Rescue Relay (a no-log pass-through, certificate still checked
// against the real hostname). apiFetch tries the direct request and, when that fails with a network
// error, asks the main process to send the same request through the relay. HTTP error statuses are
// real answers and are never retried.
const RECENT_FAILURE_MS = 60_000;
const DIRECT_RETRY_DELAY_MS = 1500;
let apiBlockedHint = false;
let lastDirectFailureAt = 0;

/** Set while the app knows a kill switch is blocking, so the relay is tried before a slow direct attempt. */
export function setApiBlockHint(blocked: boolean): void {
  apiBlockedHint = blocked;
}

function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError'));
}

async function requestViaRelay(url: string, init: RequestInit): Promise<Response | null> {
  const relay = window.electronAPI?.relayRequest;
  // A caller that cancelled the request on purpose (AbortError) does not want it sent anywhere else.
  if (!relay || (init.signal?.aborted && (init.signal.reason as { name?: string } | undefined)?.name === 'AbortError')) return null;
  if (init.body != null && typeof init.body !== 'string') return null;
  try {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const result = await relay({ url, method: init.method || 'GET', headers, body: (init.body as string | null | undefined) ?? null });
    if (!result.ok || result.status === undefined) return null;
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(result.headers ?? {})) {
      if (Array.isArray(value)) value.forEach(v => responseHeaders.append(name, v));
      else if (value != null) responseHeaders.set(name, String(value));
    }
    const noBody = result.status < 200 || result.status === 204 || result.status === 205 || result.status === 304;
    const bytes = noBody ? null : Uint8Array.from(atob(result.bodyBase64 ?? ''), c => c.charCodeAt(0));
    return new Response(bytes, { status: result.status, statusText: result.statusText ?? '', headers: responseHeaders });
  } catch {
    return null;
  }
}

async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!window.electronAPI?.relayRequest) return fetch(url, init);

  const relayFirst = apiBlockedHint || Date.now() - lastDirectFailureAt < RECENT_FAILURE_MS;
  if (relayFirst) {
    const viaRelay = await requestViaRelay(url, init);
    if (viaRelay) return viaRelay;
    // The relay did not help (for example the network is still coming back after a wake-up): stop
    // preferring it, so the next request goes direct first.
    lastDirectFailureAt = 0;
  }

  try {
    const response = await fetch(url, init);
    lastDirectFailureAt = 0;
    return response;
  } catch (firstErr) {
    let err: unknown = firstErr;
    if (!isNetworkFailure(err)) throw err;
    // A request that fails at once (not a timeout) is often just the tunnel coming up or going down.
    // Retry the direct path once before using the relay, which keeps the relay out of ordinary traffic.
    if (!relayFirst && err instanceof TypeError) {
      await new Promise(resolve => setTimeout(resolve, DIRECT_RETRY_DELAY_MS));
      try {
        const response = await fetch(url, init);
        lastDirectFailureAt = 0;
        return response;
      } catch (secondErr) {
        if (!isNetworkFailure(secondErr)) throw secondErr;
        err = secondErr;
      }
    }
    lastDirectFailureAt = Date.now();
    if (!relayFirst) {
      const viaRelay = await requestViaRelay(url, init);
      if (viaRelay) return viaRelay;
    }
    throw err;
  }
}

interface ApiError {
  message: string;
  status: number;
  // Machine-readable reason the backend tags on the few errors the app branches on
  // (e.g. 'two_factor_challenge_expired'). Absent on plain errors.
  code?: string;
}

export type OrganizationAccessValue = 'active' | 'inactive' | 'revoked';

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
  // Business / organization state. Optional so an older backend that omits them still maps.
  totpEnabled?: boolean;
  twoFactorRequiredByOrg?: boolean;
  mustChangePassword?: boolean;
  subscriptionManagedByOrganization?: boolean;
  organizationName?: string | null;
  organizationRole?: string | null;
  organizationAccess?: string | null;
  // Why this account cannot start a free trial (null = it can). Absent on an older backend.
  trialIneligibleReason?: string | null;
}

// Unknown values decode as 'active' so a future backend state never locks someone out.
export function parseOrganizationAccess(raw: string | null | undefined): OrganizationAccessValue | undefined {
  if (!raw) return undefined;
  return raw === 'inactive' || raw === 'revoked' ? raw : 'active';
}

// Where "Manage Account" and the org-required 2FA setup send the user. Falls back to the website's
// dashboard when no explicit account URL is configured.
const DASHBOARD_URL: string = import.meta.env.VITE_ACCOUNT_URL
  || `${import.meta.env.VITE_FRONTEND_URL || 'https://wiredogvpn.com'}/dashboard`;

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
  // Sliding session renewal: the backend reissues a fresh token with a renewed expiry on
  // every authenticated request, so an actively-used app never hits its token's flat TTL.
  // Persist it whenever present, even on a non-2xx response, since the token itself was
  // still valid to make the renewal decision.
  const refreshedToken = response.headers.get('X-Refreshed-Token');
  if (refreshedToken && window.electronAPI?.auth?.setToken) {
    await window.electronAPI.auth.setToken(refreshedToken);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw {
      message: error.error || 'Request failed',
      status: response.status,
      code: typeof error.code === 'string' ? error.code : undefined,
    } as ApiError;
  }
  return response.json();
}

/**
 * What a password/account-number login produced: a session, or a pending 2FA challenge the
 * caller must redeem with verifyTwoFactor.
 */
export type LoginOutcome =
  | { status: 'signedIn' }
  | { status: 'twoFactorRequired'; challengeToken: string };

interface LoginResponseBody {
  token?: string;
  requiresTwoFactor?: boolean;
  challengeToken?: string;
}

// Stores the token from a successful sign-in, or reports the 2FA challenge. /auth/login answers
// with a token, or, for an account with 2FA on, a challenge and no token.
async function finishLogin(data: LoginResponseBody): Promise<LoginOutcome> {
  if (data.requiresTwoFactor && data.challengeToken) {
    return { status: 'twoFactorRequired', challengeToken: data.challengeToken };
  }
  if (data.token && window.electronAPI?.auth?.setToken) {
    await window.electronAPI.auth.setToken(data.token);
  }
  return { status: 'signedIn' };
}

export async function login(email: string, password: string): Promise<LoginOutcome> {
  const response = await apiFetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return finishLogin(await handleResponse<LoginResponseBody>(response));
}

export async function anonymousLogin(accountNumber: string): Promise<LoginOutcome> {
  // Strip spaces from account number
  const cleanNumber = accountNumber.replace(/\s/g, '');
  const response = await apiFetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ identifier: cleanNumber }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return finishLogin(await handleResponse<LoginResponseBody>(response));
}

/**
 * Second step of a login whose first step returned 'twoFactorRequired'. `code` is a 6-digit
 * authenticator code or a recovery code. The challenge token is single-use on success but
 * survives a wrong code, so the caller can let the user retry.
 */
export async function verifyTwoFactor(challengeToken: string, code: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ challengeToken, code }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await finishLogin(await handleResponse<LoginResponseBody>(response));
}

/**
 * Whether `email`'s domain has verified SSO. Public lookup, same one the website's login uses.
 * A failed lookup counts as "no SSO" so a network blip never blocks a password login.
 */
export async function ssoAvailable(email: string): Promise<boolean> {
  const trimmed = email.trim();
  if (!trimmed.includes('@')) return false;
  try {
    const response = await apiFetch(`${API_URL}/auth/login/lookup?identifier=${encodeURIComponent(trimmed)}`, {
      method: 'GET',
      credentials: 'include',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await handleResponse<{ sso: boolean }>(response);
    return data.sso === true;
  } catch {
    return false;
  }
}

/** Redeems the one-time code from the wiredog://sso callback, proving possession of the PKCE verifier. */
export async function exchangeSsoCode(code: string, codeVerifier: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/auth/sso/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ code, codeVerifier }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await finishLogin(await handleResponse<LoginResponseBody>(response));
}

/** Replaces a temporary (admin-provisioned) password. The backend clears mustChangePassword. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const headers = await getHeaders();
  const response = await apiFetch(`${API_URL}/auth/password`, {
    method: 'PATCH',
    headers,
    credentials: 'include',
    body: JSON.stringify({ currentPassword, newPassword }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await handleResponse<unknown>(response);
}

// MARK: Password reset

export async function forgotPassword(email: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await handleResponse<unknown>(response);
}

/** Returns true when the account has 2FA on, so the reset must also carry a current 2FA code. */
export async function verifyResetCode(email: string, code: string): Promise<boolean> {
  const response = await apiFetch(`${API_URL}/auth/verify-reset-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await handleResponse<{ twoFactorRequired?: boolean }>(response);
  return data.twoFactorRequired ?? false;
}

export async function resetPassword(email: string, code: string, newPassword: string, twoFactorCode?: string): Promise<void> {
  const body: Record<string, string> = { email, code, newPassword };
  if (twoFactorCode) body.twoFactorCode = twoFactorCode;
  const response = await apiFetch(`${API_URL}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await handleResponse<unknown>(response);
}

// MARK: Dashboard handoff

// The website's plan picker. "Get a subscription" and a Connect press without an active plan open it.
const PRICING_URL = `${import.meta.env.VITE_FRONTEND_URL || 'https://wiredogvpn.com'}/pricing`;

/**
 * Builds a URL that opens the website already signed in: mints a one-time handoff code and puts
 * it in the URL fragment (never sent to a server in a request line or logged by one). Falls back
 * to the plain URL, which asks the user to sign in, if the code can't be issued.
 */
async function handoffUrl(destination: string): Promise<string> {
  try {
    const headers = await getHeaders();
    const response = await apiFetch(`${API_URL}/auth/handoff-token`, {
      method: 'POST',
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await handleResponse<{ token: string }>(response);
    const url = new URL(destination);
    url.hash = `handoff=${data.token}`;
    return url.toString();
  } catch {
    return destination;
  }
}

export function dashboardHandoffUrl(): Promise<string> {
  return handoffUrl(DASHBOARD_URL);
}

/** Opens the website's pricing page in the browser, already signed in. */
export async function openPricingPage(): Promise<void> {
  const url = await handoffUrl(PRICING_URL);
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
}

export async function logout(): Promise<void> {
  const headers = await getHeaders();
  await apiFetch(`${API_URL}/auth/logout`, {
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
  const body: Record<string, string> = { email, password, platform: 'Windows' };
  if (referralCode) body.referralCode = referralCode;
  const response = await apiFetch(`${API_URL}/auth/register/standard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await handleResponse<unknown>(response);
}

export async function registerAnonymous(): Promise<string> {
  const response = await apiFetch(`${API_URL}/auth/register/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ platform: 'Windows' }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await handleResponse<{ accountNumber: string }>(response);
  return data.accountNumber;
}

/**
 * Like getCurrentUser, but a failure is thrown instead of flattened to null, so callers can tell
 * "the backend rejected this token" (status 401) from "couldn't reach it right now" and keep the
 * session through the latter.
 */
export async function fetchCurrentUser(): Promise<MeResponse> {
  const headers = await getHeaders();
  const response = await apiFetch(`${API_URL}/auth/me`, {
    method: 'GET',
    headers,
    credentials: 'include',
  });
  return handleResponse<MeResponse>(response);
}

export async function getCurrentUser(): Promise<MeResponse | null> {
  try {
    const headers = await getHeaders();
    const response = await apiFetch(`${API_URL}/auth/me`, {
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
  // Set only on an organization member's "gateway" entry: their own named Dedicated IP on this
  // node. `id` is still the node's real server id; gatewayId is passed back when connecting.
  gatewayId?: number | null;
  gatewayName?: string | null;
}

export async function getServers(): Promise<ServerResponse[]> {
  const headers = await getHeaders();
  // gateways=1 opts in to organization "gateway" entries (named Dedicated IPs). Without it the
  // backend keeps returning the plain list.
  const response = await apiFetch(`${API_URL}/vpn/servers?gateways=1`, {
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
  const response = await apiFetch(`${API_URL}/support/report-issue`, {
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
  const response = await apiFetch(`${API_URL}/app/config`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return handleResponse<AppConfigResponse>(response);
}

/**
 * Notices staff sent to this account only (GET /auth/messages). Authenticated, unlike the public
 * announcements. Shaped like an announcement; ids start with "m" so they can never collide with an
 * announcement id in the local read-state set.
 */
export async function getAccountMessages(): Promise<Announcement[]> {
  const headers = await getHeaders();
  const response = await apiFetch(`${API_URL}/auth/messages`, {
    method: 'GET',
    headers,
    credentials: 'include',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return handleResponse<Announcement[]>(response);
}

export async function getAnnouncements(): Promise<Announcement[]> {
  const response = await apiFetch(`${API_URL}/app/announcements`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return handleResponse<Announcement[]>(response);
}

export type { MeResponse, ApiError };
