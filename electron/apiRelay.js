/**
 * Rescue Relay client.
 *
 * When a kill switch blocks the network, the backend cannot be reached directly. The relay is a
 * no-log TCP pass-through to the backend; the firewall (see KillSwitchManager.SetApiRelays) permits TCP
 * 443 to its address only. A request is sent to the relay's address but still addressed to the real
 * hostname, and the certificate is verified against that hostname, so the relay can neither read nor
 * change anything. Used only when the direct request fails (or is known to be blocked).
 *
 * The address list comes from the backend (`apiRelays` in /app/config), is kept in the settings
 * store, and is handed to the service so the block keeps those addresses reachable.
 */
const https = require('https');
const tls = require('tls');
const log = require('electron-log');

const RELAY_PORT = 443;
const RELAY_TIMEOUT_MS = 6000;
const RECENT_FAILURE_MS = 60 * 1000;
const DIRECT_RETRY_DELAY_MS = 1500;
const MAX_RELAYS = 4;
const STORE_KEY = 'apiRelays';

let relays = [];
let store = null;
let pushToService = null;
let apiHost = null;
let lastDirectFailureAt = 0;
let blockedHint = false;

function isPublicIpv4(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return false;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function validate(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const ip = typeof item === 'string' ? item.trim() : '';
    if (isPublicIpv4(ip) && !out.includes(ip)) out.push(ip);
    if (out.length >= MAX_RELAYS) break;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {{get: Function, set: Function}} opts.store - settings store (persists the address list)
 * @param {(ips: string[]) => Promise<any>} opts.push - hands the list to the service
 * @param {string} opts.apiBaseUrl - only this host is ever relayed
 */
function init({ store: s, push, apiBaseUrl }) {
  store = s;
  pushToService = push;
  try { apiHost = new URL(apiBaseUrl).hostname; } catch { apiHost = null; }
  relays = validate(store?.get(STORE_KEY));
  if (relays.length > 0) {
    log.info(`[Relay] ${relays.length} relay address(es) loaded`);
    push(relays).catch(err => log.warn(`[Relay] Could not hand addresses to the service: ${err.message}`));
  }
}

/** Update the list from the backend. An empty list switches the feature off. */
function setRelays(ips) {
  const next = validate(ips);
  if (next.length === relays.length && next.every((ip, i) => ip === relays[i])) return;
  relays = next;
  try { store?.set(STORE_KEY, relays); } catch { /* best effort */ }
  log.info(`[Relay] Relay addresses updated (${relays.length})`);
  if (pushToService) {
    pushToService(relays).catch(err => log.warn(`[Relay] Could not hand addresses to the service: ${err.message}`));
  }
}

/** Set while the app knows a kill switch is blocking, so the relay is tried before a slow direct attempt. */
function setBlockedHint(blocked) {
  blockedHint = !!blocked;
}

function canRelay(url) {
  if (relays.length === 0 || !apiHost) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === apiHost;
  } catch {
    return false;
  }
}

function isNetworkError(err) {
  if (!err) return false;
  return err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError' ||
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code);
}

function requestVia(relayIp, u, { method, headers, body }, port = RELAY_PORT) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const outHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      // Set below or by Node itself; passing them through would duplicate or conflict.
      if (['host', 'content-length', 'connection', 'transfer-encoding'].includes(name.toLowerCase())) continue;
      outHeaders[name] = value;
    }
    outHeaders.Host = u.host;
    if (payload) outHeaders['Content-Length'] = payload.length;

    const req = https.request({
      host: relayIp,
      port,
      method,
      path: u.pathname + u.search,
      headers: outHeaders,
      servername: u.hostname,
      rejectUnauthorized: true,
      // Check the certificate against the real hostname, never against the relay's address.
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(u.hostname, cert),
      timeout: RELAY_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('relay timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Send one request through the relay(s), first one that answers wins. Rejects if none does. */
async function relayRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  if (!canRelay(url)) throw new Error('relay not available for this request');
  const u = new URL(url);
  let lastErr = null;
  for (const ip of relays) {
    try {
      return await requestVia(ip, u, { method, headers, body });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no relay answered');
}

// Every request that actually travelled through the relay is logged (method, path without the query
// string, status), so a test or a support case can see the relay at work instead of inferring it.
function logRelayed(method, url, status) {
  let path = '';
  try { path = new URL(url).pathname; } catch { /* leave empty */ }
  log.info(`[Relay] relayed ${method || 'GET'} ${path} -> ${status}`);
}

function toResponse(result) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers || {})) {
    if (Array.isArray(value)) value.forEach(v => headers.append(name, v));
    else if (value != null) headers.set(name, String(value));
  }
  const noBody = result.status < 200 || result.status === 204 || result.status === 205 || result.status === 304;
  return new Response(noBody ? null : result.body, { status: result.status, statusText: result.statusText, headers });
}

function requestInit(init) {
  const headers = {};
  if (init.headers) {
    for (const [k, v] of new Headers(init.headers).entries()) headers[k] = v;
  }
  return { method: init.method || 'GET', headers, body: typeof init.body === 'string' ? init.body : null };
}

/**
 * fetch() for main-process calls to the backend: direct first, the relay if the direct request fails
 * with a network error. HTTP error statuses are real answers and are never retried.
 */
async function apiFetch(url, init = {}) {
  if (!canRelay(url) || (init.body != null && typeof init.body !== 'string')) return fetch(url, init);

  const relayFirst = blockedHint || Date.now() - lastDirectFailureAt < RECENT_FAILURE_MS;
  if (relayFirst) {
    try {
      const result = await relayRequest(url, requestInit(init));
      logRelayed(init.method, url, result.status);
      return toResponse(result);
    } catch (err) {
      log.warn(`[Relay] Relay request failed, trying direct: ${err.message}`);
      // The relay did not help (for example the whole network is still coming back after a wake-up),
      // so stop preferring it: the next request goes direct first instead of waiting on it again.
      lastDirectFailureAt = 0;
    }
  }

  try {
    const response = await fetch(url, init);
    lastDirectFailureAt = 0;
    return response;
  } catch (firstErr) {
    let err = firstErr;
    if (!isNetworkError(err)) throw err;
    if (relayFirst) throw err; // the relay was already tried
    // A request that fails at once (not a timeout) is often just the tunnel coming up or going down
    // (a normal connect or disconnect). Give the direct path a moment and one more try before the
    // relay, which also keeps the relay out of ordinary traffic.
    if (err instanceof TypeError) {
      await new Promise(resolve => setTimeout(resolve, DIRECT_RETRY_DELAY_MS));
      try {
        const response = await fetch(url, init);
        lastDirectFailureAt = 0;
        return response;
      } catch (secondErr) {
        if (!isNetworkError(secondErr)) throw secondErr;
        err = secondErr;
      }
    }
    lastDirectFailureAt = Date.now();
    try {
      log.info('[Relay] Direct request failed, using the relay');
      const result = await relayRequest(url, requestInit(init));
      logRelayed(init.method, url, result.status);
      return toResponse(result);
    } catch (relayErr) {
      log.warn(`[Relay] Relay request failed: ${relayErr.message}`);
      throw err;
    }
  }
}

/**
 * For the renderer (its fetch() cannot reach the relay): perform one request in the main process.
 * The renderer chooses nothing but method, path, headers and body; the host is always the configured
 * API host.
 * @returns {Promise<{ok: boolean, status?: number, statusText?: string, headers?: object, bodyBase64?: string}>}
 */
async function relayForRenderer({ url, method, headers, body }) {
  try {
    if (!canRelay(url)) return { ok: false };
    const result = await relayRequest(url, {
      method: typeof method === 'string' ? method.toUpperCase() : 'GET',
      headers: headers && typeof headers === 'object' ? headers : {},
      body: typeof body === 'string' ? body : null,
    });
    logRelayed(method, url, result.status);
    return {
      ok: true,
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      bodyBase64: result.body.toString('base64'),
    };
  } catch (err) {
    log.warn(`[Relay] Renderer request failed: ${err.message}`);
    return { ok: false };
  }
}

module.exports = { init, setRelays, setBlockedHint, apiFetch, relayForRenderer, _validate: validate, _requestVia: requestVia };
