const crypto = require('crypto');
const { shell } = require('electron');
const log = require('electron-log');

// Native SAML SSO for Business employees. The app opens the backend's /auth/sso/login in the
// user's browser; the backend bounces to the org's IdP, validates the assertion, and redirects to
// wiredog://sso?code=... (or ?error=...). That code is bound to a PKCE challenge generated here,
// so another app that registers the same URL scheme and sees the code cannot redeem it: only the
// verifier, which never leaves this process, completes the exchange (done by the renderer at
// POST /auth/sso/exchange).
// Backend counterpart: wiredog-backend/src/routes/auth.ts (/sso/login, /sso/acs, /sso/exchange).

const CALLBACK_SCHEME = 'wiredog';
const CALLBACK_HOST = 'sso';
// How long to wait for the browser round-trip before giving up.
const SSO_TIMEOUT_MS = 5 * 60 * 1000;

// Held only while a sign-in is waiting on the browser.
let pending = null;

function base64URL(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 43 base64url characters from 32 random bytes (RFC 7636). */
function makeCodeVerifier() {
  return base64URL(crypto.randomBytes(32));
}

function codeChallengeFor(verifier) {
  return base64URL(crypto.createHash('sha256').update(verifier).digest());
}

function settle(result, error) {
  if (!pending) return;
  const { resolve, reject, timer } = pending;
  clearTimeout(timer);
  pending = null;
  if (error) reject(error);
  else resolve(result);
}

function ssoError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Starts the browser sign-in for `domain` and resolves with { code, codeVerifier } once the
 * wiredog://sso callback arrives. Only one sign-in can be waiting at a time; starting another
 * cancels the first.
 */
function authenticate(apiBaseUrl, domain) {
  if (pending) settle(null, ssoError('SSO_CANCELLED'));

  const verifier = makeCodeVerifier();
  const startUrl = new URL(`${apiBaseUrl.replace(/\/+$/, '')}/auth/sso/login`);
  startUrl.searchParams.set('domain', domain);
  startUrl.searchParams.set('challenge', codeChallengeFor(verifier));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      log.warn('[SSO] Timed out waiting for the browser callback');
      settle(null, ssoError('SSO_CANCELLED'));
    }, SSO_TIMEOUT_MS);
    pending = { resolve, reject, timer, verifier };

    shell.openExternal(startUrl.toString()).catch((err) => {
      log.error('[SSO] Could not open the browser:', err.message);
      settle(null, ssoError('SSO_FAILED'));
    });
  });
}

/** The user backed out (or the window was closed) while the browser sign-in was pending. */
function cancel() {
  if (pending) {
    log.info('[SSO] Sign-in cancelled by user');
    settle(null, ssoError('SSO_CANCELLED'));
  }
}

/**
 * Picks the wiredog:// URL out of a process argv (Linux hands the callback to the app as a
 * command-line argument) or returns null.
 */
function findCallbackUrl(argv) {
  return (argv || []).find((arg) => typeof arg === 'string' && arg.startsWith(`${CALLBACK_SCHEME}://`)) || null;
}

/**
 * Handles a wiredog:// URL delivered by the OS. Anything that is not the expected sso callback, or
 * that arrives when no sign-in is waiting, is ignored, so a stray or malicious link cannot do
 * anything. Returns true if the URL was an SSO callback.
 */
function handleCallbackUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== `${CALLBACK_SCHEME}:` || url.hostname !== CALLBACK_HOST) return false;

  if (!pending) {
    log.warn('[SSO] Ignoring callback: no sign-in is waiting');
    return true;
  }

  const reason = url.searchParams.get('error');
  if (reason) {
    log.warn(`[SSO] Sign-in failed at the IdP/backend (${reason})`);
    settle(null, ssoError(reason === 'sso_no_account' ? 'SSO_NO_ACCOUNT' : 'SSO_FAILED'));
    return true;
  }

  const code = url.searchParams.get('code');
  if (!code || code.length !== 64) {
    log.warn('[SSO] Callback carried no valid code');
    settle(null, ssoError('SSO_FAILED'));
    return true;
  }

  log.info('[SSO] Callback received');
  settle({ code, codeVerifier: pending.verifier });
  return true;
}

module.exports = {
  CALLBACK_SCHEME,
  authenticate,
  cancel,
  findCallbackUrl,
  handleCallbackUrl,
};
