const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const log = require('electron-log');
const { VPNProtocol } = require('./base');

/**
 * WireGuard Protocol Implementation for Windows
 * Uses the official WireGuard Windows client binaries
 */
class WireGuardProtocol extends VPNProtocol {
  constructor() {
    super();
    this.tunnelName = 'WireDog';
    this.configPath = null;
    this.statusCheckInterval = null;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 3; // Allow 3 consecutive failures before disconnecting
  }

  /**
   * Get the path to WireGuard config directory
   */
  getConfigPath() {
    if (!this.configPath) {
      this.configPath = path.join(app.getPath('userData'), 'wireguard');
    }
    return this.configPath;
  }

  /**
   * Get the path to WireGuard executable
   * Checks bundled location first, then system install
   */
  getWireGuardPath() {
    // Check bundled location (production)
    const bundledPath = path.join(process.resourcesPath || '', 'bin', 'wireguard.exe');
    if (fs.existsSync(bundledPath)) {
      return bundledPath;
    }

    // Check common system install locations
    const systemPaths = [
      'C:\\Program Files\\WireGuard\\wireguard.exe',
      'C:\\Program Files (x86)\\WireGuard\\wireguard.exe'
    ];

    for (const p of systemPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    throw new Error('WireGuard not found. Please install WireGuard from https://wireguard.com/install/');
  }

  /**
   * Build WireGuard config file content
   */
  buildConfigFile(config) {
    return `[Interface]
PrivateKey = ${config.privateKey}
Address = ${config.address}
DNS = ${config.dns}

[Peer]
PublicKey = ${config.serverPublicKey}
Endpoint = ${config.endpoint}
AllowedIPs = ${config.allowedIPs}
PersistentKeepalive = ${config.persistentKeepalive}
`;
  }

  /**
   * Connect to VPN server
   */
  async connect(config) {
    log.info('WireGuard: Starting connection...');
    this.setStatus('connecting');

    try {
      // Ensure config directory exists
      const configDir = this.getConfigPath();
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Write config file
      const confFile = path.join(configDir, `${this.tunnelName}.conf`);
      const confContent = this.buildConfigFile(config);
      fs.writeFileSync(confFile, confContent, { mode: 0o600 });
      log.info(`WireGuard: Config written to ${confFile}`);

      // Get WireGuard path
      const wgPath = this.getWireGuardPath();
      log.info(`WireGuard: Using binary at ${wgPath}`);

      // First, try to uninstall any existing tunnel with this name
      try {
        execSync(`"${wgPath}" /uninstalltunnelservice "${this.tunnelName}"`, {
          windowsHide: true,
          timeout: 10000
        });
        // Wait a moment for cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (e) {
        // Tunnel may not exist, that's fine
      }

      // Install and start tunnel service
      log.info('WireGuard: Installing tunnel service...');
      execSync(`"${wgPath}" /installtunnelservice "${confFile}"`, {
        windowsHide: true,
        timeout: 30000
      });

      // Wait for connection to establish
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify connection
      log.info('WireGuard: Verifying connection...');
      if (await this.checkConnection()) {
        this.setStatus('connected');
        log.info('WireGuard: ✓ Connection verified successfully!');
        this.startStatusMonitoring();
        log.info('WireGuard: Connected successfully');
      } else {
        throw new Error('Failed to verify connection - all check methods returned false');
      }

    } catch (error) {
      log.error('WireGuard: Connection failed:', error);
      this.setStatus('error');
      // Cleanup on failure
      await this.disconnect().catch(() => {});
      throw error;
    }
  }

  /**
   * Disconnect from VPN
   */
  async disconnect() {
    log.info('WireGuard: Disconnect requested. Stopping status monitoring...');
    this.stopStatusMonitoring();

    try {
      log.info('WireGuard: Uninstalling tunnel service...');
      const wgPath = this.getWireGuardPath();
      execSync(`"${wgPath}" /uninstalltunnelservice "${this.tunnelName}"`, {
        windowsHide: true,
        timeout: 10000
      });
      log.debug('WireGuard: Tunnel service uninstalled successfully');
    } catch (error) {
      // Tunnel may not exist or already stopped
      log.warn('WireGuard: Warning during tunnel uninstall:', error.message);
    }

    // Clean up config file
    try {
      log.debug('WireGuard: Cleaning up config file...');
      const confFile = path.join(this.getConfigPath(), `${this.tunnelName}.conf`);
      if (fs.existsSync(confFile)) {
        fs.unlinkSync(confFile);
        log.debug('WireGuard: Config file deleted');
      }
    } catch (error) {
      log.warn('WireGuard: Failed to clean up config file:', error.message);
    }

    this.setStatus('disconnected');
    log.info('WireGuard: ✓ Disconnected successfully');
  }

  /**
   * Check if VPN connection is active
   * Uses multiple methods with retry logic to handle transient failures
   */
  async checkConnection() {
    const checkStart = Date.now();
    log.debug('WireGuard: Starting connection check...');

    // Method 1: Check using sc query (most reliable)
    try {
      log.debug('WireGuard: [Method 1] Checking service status with sc query...');
      const result = execSync('sc query WireGuardTunnel$WireDog', {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 5000
      });
      if (result.includes('RUNNING')) {
        const elapsed = Date.now() - checkStart;
        log.debug(`WireGuard: [Method 1] ✓ Service is RUNNING (${elapsed}ms)`);
        return true;
      } else {
        const elapsed = Date.now() - checkStart;
        log.debug(`WireGuard: [Method 1] Service found but not RUNNING (${elapsed}ms). Output: ${result.substring(0, 100)}`);
      }
    } catch (error) {
      const elapsed = Date.now() - checkStart;
      log.debug(`WireGuard: [Method 1] ✗ sc query failed (${elapsed}ms): ${error.message}. Trying fallback...`);
    }

    // Method 2: Check using tasklist (fallback for service query failures)
    try {
      log.debug('WireGuard: [Method 2] Checking for wireguard processes with tasklist...');
      const result = execSync('tasklist /v', {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 5000
      });
      // Look for wireguard-related processes
      if (result.toLowerCase().includes('wireguard')) {
        const elapsed = Date.now() - checkStart;
        log.debug(`WireGuard: [Method 2] ✓ WireGuard process found (${elapsed}ms)`);
        return true;
      } else {
        const elapsed = Date.now() - checkStart;
        log.debug(`WireGuard: [Method 2] No WireGuard process found in tasklist (${elapsed}ms). Trying final fallback...`);
      }
    } catch (error) {
      const elapsed = Date.now() - checkStart;
      log.debug(`WireGuard: [Method 2] ✗ tasklist check failed (${elapsed}ms): ${error.message}. Trying final fallback...`);
    }

    // Method 3: Check if WireGuard network adapter is present
    try {
      log.debug('WireGuard: [Method 3] Checking for WireGuard network adapter with ipconfig...');
      const result = execSync('ipconfig /all', {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 5000
      });
      // Check for WireGuard-created adapter (usually contains "WireGuard" in description or is 10.x.x.x)
      const hasWireGuardAdapter = result.toLowerCase().includes('wireguard');
      const has10Adapter = result.includes('10.0.0.');

      if (hasWireGuardAdapter || has10Adapter) {
        const elapsed = Date.now() - checkStart;
        const reason = hasWireGuardAdapter ? 'WireGuard adapter found' : '10.0.0.x adapter found';
        log.debug(`WireGuard: [Method 3] ✓ ${reason} (${elapsed}ms)`);
        return true;
      } else {
        const elapsed = Date.now() - checkStart;
        log.debug(`WireGuard: [Method 3] No WireGuard adapter found (${elapsed}ms)`);
      }
    } catch (error) {
      const elapsed = Date.now() - checkStart;
      log.debug(`WireGuard: [Method 3] ✗ ipconfig check failed (${elapsed}ms): ${error.message}`);
    }

    const totalElapsed = Date.now() - checkStart;
    log.warn(`WireGuard: ✗ All connection checks failed (${totalElapsed}ms total). Connection may be lost.`);
    return false;
  }

  /**
   * Start monitoring connection status
   * Uses consecutive failure tracking to avoid disconnecting on transient failures
   */
  startStatusMonitoring() {
    this.stopStatusMonitoring();
    this.consecutiveFailures = 0;
    let checkCount = 0;

    log.info('WireGuard: Status monitoring started (checks every 5 seconds)');

    this.statusCheckInterval = setInterval(async () => {
      checkCount++;
      const checkNumber = checkCount;

      try {
        const isConnected = await this.checkConnection();

        if (isConnected) {
          // Connection is good, reset failure counter
          if (this.consecutiveFailures > 0) {
            log.info(`WireGuard: [Check #${checkNumber}] ✓ Connection check passed. Resetting failure counter (was ${this.consecutiveFailures})`);
            this.consecutiveFailures = 0;
          } else {
            log.debug(`WireGuard: [Check #${checkNumber}] ✓ Connection check passed`);
          }
        } else if (this.status === 'connected') {
          // Connection check failed, increment failure counter
          this.consecutiveFailures++;

          if (this.consecutiveFailures === 1) {
            log.warn(`WireGuard: [Check #${checkNumber}] ✗ Connection check FAILED (${this.consecutiveFailures}/${this.maxConsecutiveFailures})`);
          } else if (this.consecutiveFailures < this.maxConsecutiveFailures) {
            log.warn(`WireGuard: [Check #${checkNumber}] ✗ Connection check FAILED (${this.consecutiveFailures}/${this.maxConsecutiveFailures})`);
          } else {
            // Only disconnect after multiple consecutive failures
            log.error(`WireGuard: [Check #${checkNumber}] ✗ Connection lost! Failed ${this.consecutiveFailures} consecutive checks. Disconnecting...`);
            this.setStatus('disconnected');
            this.stopStatusMonitoring();
          }
        }
      } catch (error) {
        log.error(`WireGuard: [Check #${checkNumber}] Unexpected error during connection check: ${error.message}`);
      }
    }, 5000);
  }

  /**
   * Stop monitoring connection status
   */
  stopStatusMonitoring() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
  }

  /**
   * Get connection statistics (if available)
   */
  async getStats() {
    try {
      const wgPath = path.dirname(this.getWireGuardPath());
      const wgExe = path.join(wgPath, 'wg.exe');

      if (!fs.existsSync(wgExe)) {
        return null;
      }

      const result = execSync(`"${wgExe}" show "${this.tunnelName}"`, {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 5000
      });

      // Parse output for transfer stats
      const rxMatch = result.match(/transfer:\s+([\d.]+\s*\w+)\s+received/i);
      const txMatch = result.match(/transfer:.*,\s+([\d.]+\s*\w+)\s+sent/i);

      return {
        bytesReceived: rxMatch ? rxMatch[1] : '0',
        bytesSent: txMatch ? txMatch[1] : '0'
      };
    } catch (error) {
      return null;
    }
  }
}

module.exports = { WireGuardProtocol };
