/**
 * Base VPN Protocol interface
 * All protocol implementations must extend this class
 */
class VPNProtocol {
  constructor() {
    this.status = 'disconnected';
    this.statusCallbacks = [];
  }

  /**
   * Connect to VPN using the provided config
   * @param {Object} config - WireGuard/OpenVPN config object
   */
  async connect(config) {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from VPN
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Get current connection status
   * @returns {'disconnected' | 'connecting' | 'connected' | 'error'}
   */
  getStatus() {
    return this.status;
  }

  /**
   * Set status and notify all listeners
   * @param {'disconnected' | 'connecting' | 'connected' | 'error'} status
   */
  setStatus(status) {
    this.status = status;
    this.statusCallbacks.forEach(cb => cb(status));
  }

  /**
   * Register a callback for status changes
   * @param {Function} callback
   */
  onStatusChange(callback) {
    this.statusCallbacks.push(callback);
  }
}

module.exports = { VPNProtocol };
