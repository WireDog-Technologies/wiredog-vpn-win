/**
 * Named Pipe client for communicating with the WireDog VPN Windows Service
 * Uses JSON-RPC 2.0 protocol over named pipes
 */

const net = require('net');
const log = require('electron-log');
const { createRequest, parseNotification } = require('./json-rpc');

const PIPE_NAME = process.env.NODE_ENV === 'development' ? 'WireDog-dev' : 'WireDog';
const PIPE_PATH = `\\\\.\\pipe\\${PIPE_NAME}`;
const CONNECT_TIMEOUT = 5000;
const REQUEST_TIMEOUT = 30000;

/**
 * ServiceClient - Connects to the WireDog VPN Windows Service
 */
class ServiceClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.pendingRequests = new Map();
    this.notificationHandlers = new Map();
    this.buffer = '';
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  /**
   * Connect to the service
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, CONNECT_TIMEOUT);

      this.socket = net.createConnection(PIPE_PATH, () => {
        clearTimeout(timeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        log.info(`Connected to service at ${PIPE_PATH}`);
        resolve();
      });

      this.socket.on('data', (data) => this.handleData(data));

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        log.error('Service connection error:', err.message);
        this.handleDisconnect();
        reject(err);
      });

      this.socket.on('close', () => {
        log.info('Service connection closed');
        this.handleDisconnect();
      });
    });
  }

  /**
   * Disconnect from the service
   */
  disconnect() {
    this.clearReconnectTimer();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.rejectPendingRequests(new Error('Disconnected'));
  }

  /**
   * Send a request and wait for response
   * @param {string} method - Method name
   * @param {object} params - Method parameters
   * @returns {Promise<any>} Response result
   */
  async request(method, params = null) {
    if (!this.connected) {
      await this.connect();
    }

    const message = createRequest(method, params);
    const id = JSON.parse(message).id;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.send(message);
    });
  }

  /**
   * Register a handler for notifications
   * @param {string} method - Notification method name
   * @param {function} handler - Handler function
   */
  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Send raw message
   * @param {string} message - JSON string
   */
  send(message) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to service');
    }
    this.socket.write(message + '\n');
    try {
      const parsed = JSON.parse(message);
      log.debug('Sent: method=%s id=%s', parsed.method, parsed.id);
    } catch {
      log.debug('Sent: (unparseable message)');
    }
  }

  /**
   * Handle incoming data
   * @param {Buffer} data
   */
  handleData(data) {
    this.buffer += data.toString('utf-8');

    // Process complete lines
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        this.handleMessage(line.trim());
      }
    }
  }

  /**
   * Handle a complete message
   * @param {string} json - JSON string
   */
  handleMessage(json) {
    try {
      const parsed = JSON.parse(json);
      log.debug('Received: method=%s id=%s', parsed.method, parsed.id);
    } catch {
      log.debug('Received: (unparseable message)');
    }

    // Check if notification
    const notification = parseNotification(json);
    if (notification) {
      const handler = this.notificationHandlers.get(notification.method);
      if (handler) {
        try {
          handler(notification.params);
        } catch (err) {
          log.error('Notification handler error:', err);
        }
      }
      return;
    }

    // Parse as response
    try {
      const parsed = JSON.parse(json);
      const pending = this.pendingRequests.get(parsed.id);

      if (pending) {
        this.pendingRequests.delete(parsed.id);

        if (parsed.error) {
          const error = new Error(parsed.error.message);
          error.code = parsed.error.code;
          error.data = parsed.error.data;
          pending.reject(error);
        } else {
          pending.resolve(parsed.result);
        }
      }
    } catch (err) {
      log.error('Failed to parse message:', err);
    }
  }

  /**
   * Handle disconnect
   */
  handleDisconnect() {
    this.connected = false;
    this.socket = null;
    this.rejectPendingRequests(new Error('Connection lost'));
    this.scheduleReconnect();
  }

  /**
   * Reject all pending requests
   * @param {Error} error
   */
  rejectPendingRequests(error) {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.warn('Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    log.info(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        log.warn('Reconnect failed:', err.message);
      }
    }, delay);
  }

  /**
   * Clear reconnect timer
   */
  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ============ High-level API methods ============

  /**
   * Ping the service
   * @returns {Promise<{version: string, uptime: number}>}
   */
  async ping() {
    return this.request('ping');
  }

  /**
   * Get service configuration (local mode, dev mode, etc.)
   * @returns {Promise<{localMode: boolean, devMode: boolean, pipeName: string}>}
   */
  async getConfig() {
    return this.request('getConfig');
  }

  /**
   * Connect to VPN
   * @param {string} serverId - Server ID
   * @param {object} config - WireGuard config
   * @param {boolean} killSwitch - Enable kill switch
   * @param {boolean} localMode - Local testing mode (for local IP instead of public IP)
   * @param {object} [splitTunneling] - Split tunneling config
   * @returns {Promise<{sessionId: string, assignedIp: string}>}
   */
  async vpnConnect(serverId, config, killSwitch = false, localMode = false, splitTunneling = null) {
    const params = {
      serverId,
      config,
      killSwitch,
      localMode
    };
    if (splitTunneling) {
      params.splitTunneling = splitTunneling;
    }
    return this.request('connect', params);
  }

  /**
   * Disconnect from VPN
   * @param {boolean} [disableProtection=true] - If true, fully disable all protection. If false, keep advanced KS active.
   * @returns {Promise<{success: boolean}>}
   */
  async vpnDisconnect(disableProtection = true) {
    return this.request('disconnect', { disableProtection });
  }

  /**
   * Get VPN status
   * @returns {Promise<{state: string, killSwitchActive: boolean, ...}>}
   */
  async getStatus() {
    return this.request('getStatus');
  }

  /**
   * Get VPN statistics
   * @returns {Promise<{bytesIn: number, bytesOut: number}>}
   */
  async getStats() {
    return this.request('getStats');
  }

  /**
   * Enable kill switch
   * @param {string} serverIp - VPN server IP
   * @param {number} interfaceIndex - VPN interface index
   * @returns {Promise<{success: boolean}>}
   */
  async enableKillSwitch(serverIp, interfaceIndex = 0) {
    return this.request('enableKillSwitch', { serverIp, interfaceIndex });
  }

  /**
   * Disable kill switch
   * @returns {Promise<{success: boolean}>}
   */
  async disableKillSwitch() {
    return this.request('disableKillSwitch');
  }

  /**
   * Enable advanced (permanent) kill switch setting
   * @returns {Promise<{success: boolean}>}
   */
  async enableAdvancedKillSwitch() {
    return this.request('enableAdvancedKillSwitch');
  }

  /**
   * Disable advanced (permanent) kill switch setting
   * @returns {Promise<{success: boolean}>}
   */
  async disableAdvancedKillSwitch() {
    return this.request('disableAdvancedKillSwitch');
  }

  /**
   * Emergency reset: nuke ALL WFP filters (fail-safe for testing)
   * @returns {Promise<{success: boolean}>}
   */
  async emergencyReset() {
    return this.request('emergencyReset');
  }

  /**
   * Get DNS filter statistics
   * Dumps filter statistics to service logs for debugging
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async getDnsFilterStats() {
    return this.request('getDnsFilterStats');
  }

  /**
   * Start the Windows Service
   * @returns {Promise<void>}
   */
  async startService() {
    const { execSync } = require('child_process');
    try {
      execSync('sc start WireDogVPNService', { stdio: 'pipe' });
      log.info('Windows Service started successfully');
      // Wait for service to be ready
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      log.error('Failed to start Windows Service:', error.message);
      throw new Error('Failed to start Windows Service');
    }
  }
}

// Export singleton instance
const serviceClient = new ServiceClient();
module.exports = serviceClient;
