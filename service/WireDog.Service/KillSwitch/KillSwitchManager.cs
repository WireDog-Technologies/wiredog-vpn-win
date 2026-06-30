using WireDog.Service.Wfp;

namespace WireDog.Service.KillSwitch;

/// <summary>
/// Manages the VPN kill switch using WFP with a state-driven approach.
///
/// States:
/// - Disabled: No filters active
/// - Bootstrap: Pre-connect phase with minimal allowlist (VPN server, DHCP, DNS, LAN)
/// - Connected: Post-connect phase with tunnel interface permitted
///
/// This ensures protection during the entire connection lifecycle.
/// </summary>
public class KillSwitchManager : IDisposable
{
    private readonly ILogger<KillSwitchManager> _logger;
    private readonly WfpEngine _wfpEngine;
    private readonly List<ulong> _activeFilters = new();
    private readonly object _lock = new();
    private bool _disposed;

    private KillSwitchState _state = KillSwitchState.Disabled;
    private string? _vpnServerIp;
    private ushort _vpnServerPort;
    private bool _vpnIsTcp;
    private uint _vpnInterfaceIndex;
    private readonly List<ulong> _bootstrapIpv6BlockFilterIds = new();

    // Advanced Kill Switch (persistent mode)
    private AdvancedKillSwitchConfig _advancedConfig = new();
    private bool _persistentBlockActive = false;

    // DNS leak protection (independent of kill switch)
    private readonly List<ulong> _dnsFilters = new();
    private bool _dnsLeakProtectionActive = false;

    // IPv6 leak protection (independent of kill switch and DNS)
    private readonly List<ulong> _ipv6Filters = new();
    private bool _ipv6LeakProtectionActive = false;

    // Track tunnel interface filter for clean removal during connection drop
    private ulong _tunnelInterfaceFilterId = 0;

    // Track physical interface permit filters for split tunnel + kill switch compatibility
    private readonly List<ulong> _physicalInterfaceFilterIds = new();

    public KillSwitchState State => _state;
    public bool IsEnabled => _state != KillSwitchState.Disabled;
    public bool IsDnsLeakProtectionActive => _dnsLeakProtectionActive;
    public bool IsIpv6LeakProtectionActive => _ipv6LeakProtectionActive;
    public bool IsAdvancedModeEnabled => _advancedConfig.AdvancedModeEnabled;
    public bool IsAdvancedModeActive => _persistentBlockActive;

    public KillSwitchManager(ILogger<KillSwitchManager> logger, WfpEngine wfpEngine)
    {
        _logger = logger;
        _wfpEngine = wfpEngine;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        lock (_lock)
        {
            if (_state != KillSwitchState.Disabled)
            {
                _logger.LogInformation("[CLEANUP] KillSwitchManager being disposed - ensuring all filters are removed");
                DisableInternal();
            }
        }
    }

    ~KillSwitchManager()
    {
        Dispose();
    }

    /// <summary>
    /// Enable bootstrap phase kill switch (before tunnel establishment).
    /// Allows: VPN server endpoint, DHCP, DNS, LAN, loopback
    /// Blocks: All other traffic
    /// </summary>
    /// <param name="vpnServerIp">VPN server IP address</param>
    /// <param name="vpnServerPort">VPN server port</param>
    /// <param name="isTcp">True for TCP, false for UDP</param>
    public void EnableBootstrap(string vpnServerIp, ushort vpnServerPort, bool isTcp = false)
    {
        lock (_lock)
        {
            _logger.LogInformation("========================================");
            _logger.LogInformation("[MILESTONE] KILL SWITCH - PHASE 1: BOOTSTRAP");
            _logger.LogInformation("========================================");
            _logger.LogInformation("  State transition: {OldState} -> Bootstrap", _state);
            _logger.LogInformation("  VPN Server: {ServerIp}:{Port}", vpnServerIp, vpnServerPort);
            _logger.LogInformation("  Protocol: {Protocol}", isTcp ? "TCP" : "UDP");
            _logger.LogInformation("  Purpose: Block all traffic EXCEPT VPN server before tunnel establishment");

            // If persistent block is active, suspend it for the connection attempt.
            // Dynamic kill switch provides protection during connection.
            // Persistent block will be re-added on disconnect if advanced mode is still enabled.
            if (_persistentBlockActive)
            {
                _logger.LogInformation("  Persistent block active — suspending for connection attempt");
                DisablePersistentBlockInternal();
            }

            if (_state != KillSwitchState.Disabled)
            {
                _logger.LogWarning("  Kill switch already enabled (state: {State}), disabling first", _state);
                DisableInternal();
            }

            _vpnServerIp = vpnServerIp;
            _vpnServerPort = vpnServerPort;
            _vpnIsTcp = isTcp;

            try
            {
                AddBootstrapFilters();
                TransitionState(KillSwitchState.Bootstrap, "EnableBootstrap");
                _logger.LogInformation("----------------------------------------");
                _logger.LogInformation("[SUCCESS] Bootstrap phase ACTIVE with {Count} WFP filters", _activeFilters.Count);
                _logger.LogInformation("  Traffic allowed: VPN server, LAN, DHCP, DNS, Loopback");
                _logger.LogInformation("  Traffic blocked: All other IPv4/IPv6");
                _logger.LogInformation("========================================");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[FAILED] Could not enable bootstrap phase");
                DisableInternal();
                throw;
            }
        }
    }

    /// <summary>
    /// Update the bootstrap VPN server permit after DNS resolution.
    /// Call this when EnableBootstrap() was called with an empty IP and the hostname has now been resolved.
    /// </summary>
    public void UpdateBootstrapServerPermit(string serverIp, ushort serverPort, bool isTcp = false)
    {
        lock (_lock)
        {
            if (_state != KillSwitchState.Bootstrap)
            {
                _logger.LogWarning("[KS] UpdateBootstrapServerPermit: not in bootstrap state ({State}), skipping", _state);
                return;
            }

            _vpnServerIp = serverIp;
            _vpnServerPort = serverPort;
            _vpnIsTcp = isTcp;

            _logger.LogInformation("[KS] Adding VPN server permit post-DNS: {Ip}:{Port}", serverIp, serverPort);
            try
            {
                var serverId = _wfpEngine.AddPermitVpnServerFilter(
                    $"Permit VPN Server {serverIp}:{serverPort}",
                    serverIp, serverPort, isTcp, 190);
                _activeFilters.Add(serverId);

                var serverInboundId = _wfpEngine.AddPermitVpnServerInboundFilter(
                    $"Permit VPN Server Inbound {serverIp}",
                    serverIp, serverPort, isTcp, 190);
                _activeFilters.Add(serverInboundId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[KS] Failed to add VPN server permit after DNS resolution");
                throw;
            }
        }
    }

    /// <summary>
    /// Transition from bootstrap to connected phase (after tunnel is up).
    /// Adds: VPN tunnel interface permit (IPv4 + IPv6), DNS leak protection
    /// Keeps: VPN server (for keep-alive), DHCP, DNS (general), LAN, block-all
    /// </summary>
    /// <param name="interfaceIndex">VPN tunnel interface index</param>
    public void TransitionToConnected(uint interfaceIndex)
    {
        lock (_lock)
        {
            _logger.LogInformation("========================================");
            _logger.LogInformation("[MILESTONE] KILL SWITCH - PHASE 2: CONNECTED");
            _logger.LogInformation("========================================");
            _logger.LogInformation("  State transition: {OldState} -> Connected", _state);
            _logger.LogInformation("  VPN Interface Index: {Index}", interfaceIndex);
            _logger.LogInformation("  Purpose: Add tunnel permits + DNS leak protection");

            if (_state != KillSwitchState.Bootstrap)
            {
                _logger.LogWarning("[SKIPPED] Cannot transition: not in bootstrap state (current: {State})", _state);
                return;
            }

            _vpnInterfaceIndex = interfaceIndex;

            try
            {
                // 1. Add IPv4 tunnel interface permit (highest priority)
                var tunnelIdV4 = _wfpEngine.AddPermitTunnelInterfaceFilter(
                    $"Permit VPN Tunnel Interface {interfaceIndex}", interfaceIndex, 250);
                _tunnelInterfaceFilterId = tunnelIdV4;  // Track for clean removal in TransitionToBootstrap
                _activeFilters.Add(tunnelIdV4);

                // NOTE: DNS leak protection is now handled by EnableDnsLeakProtection()
                // which is called after TransitionToConnected() regardless of kill switch state.
                // This ensures DNS protection works even when kill switch is disabled.
                //
                // IPv6 leak protection is handled by EnableIpv6LeakProtection()
                // which conditionally routes IPv6 through tunnel or blocks it entirely.

                TransitionState(KillSwitchState.Connected, "TransitionToConnected");
                _logger.LogInformation("----------------------------------------");
                _logger.LogInformation("[SUCCESS] Connected phase ACTIVE with {Count} kill switch filters", _activeFilters.Count);
                _logger.LogInformation("  Kill switch protection: Block all traffic except:");
                _logger.LogInformation("    - VPN tunnel interface (traffic routed through VPN)");
                _logger.LogInformation("    - VPN server endpoint (for keep-alive)");
                _logger.LogInformation("    - LAN subnets (local network access)");
                _logger.LogInformation("    - DHCP (network connectivity)");
                _logger.LogInformation("  Note: DNS leak protection will be enabled separately (always on)");
                _logger.LogInformation("  Note: IPv6 leak protection will be enabled separately (conditional)");
                _logger.LogInformation("========================================");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[FAILED] Could not transition to connected (staying in bootstrap)");
                // Stay in bootstrap state - still protected
            }
        }
    }

    /// <summary>
    /// Transition from connected back to bootstrap (on connection drop).
    /// Removes: VPN tunnel interface permit only
    /// Keeps: All bootstrap filters for reconnection attempts (no traffic leak window)
    /// </summary>
    public void TransitionToBootstrap()
    {
        lock (_lock)
        {
            _logger.LogInformation("========================================");
            _logger.LogWarning("[MILESTONE] KILL SWITCH - CONNECTION DROP DETECTED");
            _logger.LogInformation("========================================");
            _logger.LogInformation("  State transition: {OldState} -> Bootstrap", _state);
            _logger.LogInformation("  Purpose: Maintain protection while allowing reconnection");

            if (_state != KillSwitchState.Connected)
            {
                _logger.LogWarning("[SKIPPED] Cannot transition: not in connected state (current: {State})", _state);
                return;
            }

            // Remove physical interface permit (split tunnel traffic must be blocked too)
            RemovePhysicalInterfacePermit();

            // Only remove the tunnel interface filter - keep all bootstrap filters intact
            // This eliminates the brief window of no protection during rebuild
            if (_tunnelInterfaceFilterId != 0)
            {
                try
                {
                    _wfpEngine.RemoveFilter(_tunnelInterfaceFilterId);
                    _activeFilters.Remove(_tunnelInterfaceFilterId);
                    _logger.LogInformation("  Removed tunnel interface filter (ID: {Id})", _tunnelInterfaceFilterId);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "  Failed to remove tunnel interface filter");
                }
                _tunnelInterfaceFilterId = 0;
            }

            TransitionState(KillSwitchState.Bootstrap, "TransitionToBootstrap (connection drop)");
            _vpnInterfaceIndex = 0;

            _logger.LogInformation("----------------------------------------");
            _logger.LogInformation("[SUCCESS] Back in BOOTSTRAP mode - ready for reconnection");
            _logger.LogInformation("  Bootstrap filters remain ACTIVE ({Count} filters)", _activeFilters.Count);
            _logger.LogInformation("  Traffic protected: Only VPN server, LAN, DHCP, DNS, Loopback allowed");
            _logger.LogInformation("========================================");
        }
    }

    // ============ Split Tunnel IP Permits ============

    private readonly List<ulong> _splitTunnelIpFilterIds = new();

    /// <summary>
    /// Add WFP PERMIT filters for excluded IPs so they bypass the kill switch.
    /// Only call in exclude mode when kill switch is active.
    /// </summary>
    public void AddSplitTunnelIpPermits(List<string> ips)
    {
        lock (_lock)
        {
            if (_state == KillSwitchState.Disabled)
            {
                _logger.LogInformation("[SplitTunnel IP] Kill switch disabled — IP permits not needed");
                return;
            }

            _logger.LogInformation("[SplitTunnel IP] Adding WFP PERMIT filters for {Count} excluded IPs", ips.Count);

            foreach (var ipCidr in ips)
            {
                var trimmed = ipCidr.Trim();
                if (string.IsNullOrEmpty(trimmed)) continue;

                try
                {
                    bool isIpv6 = trimmed.Contains(':');
                    int slashIdx = trimmed.IndexOf('/');
                    string ipPart = slashIdx >= 0 ? trimmed[..slashIdx] : trimmed;
                    int prefixLen = slashIdx >= 0 ? int.Parse(trimmed[(slashIdx + 1)..]) : (isIpv6 ? 128 : 32);

                    List<ulong> filterIds;
                    if (isIpv6)
                    {
                        filterIds = _wfpEngine.AddPermitRemoteIpv6Filter(
                            $"SplitTunnel Permit {trimmed}", ipPart, prefixLen, 150);
                    }
                    else
                    {
                        filterIds = _wfpEngine.AddPermitRemoteIpv4Filter(
                            $"SplitTunnel Permit {trimmed}", ipPart, prefixLen, 150);
                    }

                    _splitTunnelIpFilterIds.AddRange(filterIds);
                    _logger.LogInformation("[SplitTunnel IP] Added {Count} WFP permits for {IP}",
                        filterIds.Count, trimmed);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[SplitTunnel IP] Failed to add permit for {IP}", trimmed);
                }
            }

            _logger.LogInformation("[SplitTunnel IP] Total IP permit filters: {Count}", _splitTunnelIpFilterIds.Count);
        }
    }

    /// <summary>
    /// Remove all split tunnel IP permit filters.
    /// </summary>
    public void RemoveSplitTunnelIpPermits()
    {
        lock (_lock)
        {
            if (_splitTunnelIpFilterIds.Count == 0) return;

            _logger.LogInformation("[SplitTunnel IP] Removing {Count} IP permit filters", _splitTunnelIpFilterIds.Count);

            foreach (var filterId in _splitTunnelIpFilterIds)
            {
                try { _wfpEngine.RemoveFilter(filterId); }
                catch (Exception ex) { _logger.LogWarning(ex, "[SplitTunnel IP] Failed to remove filter {Id}", filterId); }
            }

            _splitTunnelIpFilterIds.Clear();
        }
    }

    // ============ Physical Interface Permit (Split Tunnel + Kill Switch) ============

    /// <summary>
    /// Add WFP PERMIT filters for the physical adapter interface so split-tunneled
    /// traffic can exit via physical while the kill switch is active.
    /// Weight 150: above block-all (10), below DNS block (165) so DNS stays tunneled.
    /// </summary>
    public void AddPhysicalInterfacePermit(uint physicalInterfaceIndex)
    {
        lock (_lock)
        {
            if (_state == KillSwitchState.Disabled)
            {
                _logger.LogInformation("[SplitTunnel] Kill switch disabled — physical permit not needed");
                return;
            }

            _logger.LogInformation("[SplitTunnel] Adding physical interface PERMIT for split tunnel (ifIndex={Index}, weight=150)", physicalInterfaceIndex);

            try
            {
                var filterIds = _wfpEngine.AddPermitInterfaceFilters(
                    $"Split Tunnel - Permit Physical Interface {physicalInterfaceIndex}",
                    physicalInterfaceIndex, 150);

                _physicalInterfaceFilterIds.AddRange(filterIds);
                _activeFilters.AddRange(filterIds);

                _logger.LogInformation("[SplitTunnel] Physical interface permit added: {Count} filters", filterIds.Count);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SplitTunnel] Failed to add physical interface permit");
            }
        }
    }

    /// <summary>
    /// Remove physical interface permit filters (on disconnect or connection drop).
    /// </summary>
    public void RemovePhysicalInterfacePermit()
    {
        lock (_lock)
        {
            if (_physicalInterfaceFilterIds.Count == 0) return;

            _logger.LogInformation("[SplitTunnel] Removing {Count} physical interface permit filters", _physicalInterfaceFilterIds.Count);

            foreach (var filterId in _physicalInterfaceFilterIds)
            {
                try
                {
                    _wfpEngine.RemoveFilter(filterId);
                    _activeFilters.Remove(filterId);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[SplitTunnel] Failed to remove physical permit filter {Id}", filterId);
                }
            }

            _physicalInterfaceFilterIds.Clear();
        }
    }

    /// <summary>
    /// Disable the kill switch completely and remove all filters (including persistent if active).
    /// </summary>
    public void Disable()
    {
        lock (_lock)
        {
            _logger.LogInformation("========================================");
            _logger.LogInformation("[MILESTONE] KILL SWITCH - DISABLING");
            _logger.LogInformation("========================================");
            _logger.LogInformation("  Current state: {State}", _state);
            _logger.LogInformation("  Purpose: Remove all WFP filters, restore normal traffic");

            // If persistent block is active, remove persistent filters too
            if (_persistentBlockActive)
            {
                DisablePersistentBlockInternal();
            }

            DisableInternal();
        }
    }

    private void DisableInternal()
    {
        if (_state == KillSwitchState.Disabled && _activeFilters.Count == 0)
        {
            _logger.LogDebug("  Kill switch already disabled, nothing to do");
            return;
        }

        _logger.LogInformation("  Removing {Count} WFP filters...", _activeFilters.Count);

        int removed = 0;
        int failed = 0;
        foreach (var filterId in _activeFilters)
        {
            try
            {
                if (filterId != 0) // Skip dummy IDs
                {
                    _wfpEngine.RemoveFilter(filterId);
                    removed++;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "  Failed to remove filter {Id}", filterId);
                failed++;
            }
        }

        _activeFilters.Clear();
        _splitTunnelIpFilterIds.Clear(); // Also clean up IP permit tracking
        _physicalInterfaceFilterIds.Clear(); // Also clean up physical permit tracking
        TransitionState(KillSwitchState.Disabled, "DisableInternal");
        _vpnServerIp = null;
        _vpnInterfaceIndex = 0;
        _tunnelInterfaceFilterId = 0;
        _bootstrapIpv6BlockFilterIds.Clear();

        // If many filters failed to remove, use emergency cleanup
        if (failed > 0 && failed >= removed)
        {
            _logger.LogWarning("Many filters failed to remove ({Failed}/{Total}), using emergency cleanup",
                failed, removed + failed);
            try
            {
                _wfpEngine.EmergencyCleanup();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Emergency cleanup failed");
            }
        }

        _logger.LogInformation("----------------------------------------");
        _logger.LogInformation("[SUCCESS] Kill switch DISABLED - {Removed} filters removed, {Failed} failed",
            removed, failed);
        _logger.LogInformation("  Normal traffic flow restored");
        _logger.LogInformation("========================================");
    }

    // ============ Advanced Kill Switch (Persistent Mode) ============

    /// <summary>
    /// Enable advanced persistent mode. Call after TransitionToConnected() if setting is enabled.
    /// Creates persistent block-all filters in BFE (survive process exit and reboot).
    /// State → ConnectedPersistent
    /// </summary>
    public void EnablePersistentBlock()
    {
        lock (_lock)
        {
            if (_state != KillSwitchState.Connected)
            {
                _logger.LogWarning("[AdvKS] Cannot enable persistent block: not in Connected state (current: {State})", _state);
                return;
            }

            _logger.LogInformation("[AdvKS] Enabling persistent block-all filters...");

            try
            {
                _wfpEngine.OpenPersistentSession();
                _wfpEngine.AddPersistentBlockAllFilters();

                _persistentBlockActive = true;
                TransitionState(KillSwitchState.ConnectedPersistent, "EnablePersistentBlock");

                _advancedConfig.AdvancedModeActive = true;
                _advancedConfig.Save();

                _logger.LogInformation("[AdvKS] Persistent block active — state: ConnectedPersistent");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[AdvKS] Failed to enable persistent block");
                // Try to clean up partial state
                try { _wfpEngine.RemovePersistentBlockAllFilters(); } catch { /* best effort */ }
                _persistentBlockActive = false;
                throw;
            }
        }
    }

    /// <summary>
    /// Disconnect while adding persistent block-all filters. Dynamic filters removed,
    /// persistent filters created to block internet until reconnection.
    /// State → PersistentBlock (no tunnel, internet blocked)
    /// </summary>
    public void DisconnectWithPersistentBlock()
    {
        lock (_lock)
        {
            _logger.LogInformation("[AdvKS] Disconnecting with persistent block...");

            // Remove DNS/IPv6/split tunnel filters
            DisableDnsLeakProtection();
            DisableIpv6LeakProtection();
            RemoveSplitTunnelIpPermits();
            RemovePhysicalInterfacePermit();

            // Remove all dynamic kill switch filters
            DisableInternal();

            // Create persistent block-all filters (block internet until reconnect)
            try
            {
                _wfpEngine.OpenPersistentSession();
                _wfpEngine.AddPersistentBlockAllFilters();
                _logger.LogInformation("[AdvKS] Persistent block-all filters created");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[AdvKS] Failed to create persistent block-all filters");
            }

            // State → PersistentBlock
            TransitionState(KillSwitchState.PersistentBlock, "DisconnectWithPersistentBlock");
            _persistentBlockActive = true;

            _advancedConfig.AdvancedModeActive = true;
            _advancedConfig.Save();

            _logger.LogInformation("[AdvKS] State: PersistentBlock — internet blocked, persistent filters active");
        }
    }

    /// <summary>
    /// Disable persistent block and remove all persistent filters.
    /// State → Disabled
    /// </summary>
    public void DisablePersistentBlock()
    {
        lock (_lock)
        {
            _logger.LogInformation("[AdvKS] Disabling persistent block — removing all persistent filters...");

            DisablePersistentBlockInternal();

            // Also remove any remaining dynamic filters
            if (_state != KillSwitchState.Disabled)
            {
                DisableInternal();
            }

            _logger.LogInformation("[AdvKS] Persistent block disabled — normal internet restored");
        }
    }

    /// <summary>
    /// Emergency reset: nuke ALL WFP filters (kill switch, persistent block, DNS, IPv6).
    /// Used as a fail-safe when the user is locked out during testing.
    /// </summary>
    public void EmergencyReset()
    {
        lock (_lock)
        {
            _logger.LogWarning("========================================");
            _logger.LogWarning("[EMERGENCY] EMERGENCY RESET — Removing ALL WFP filters");
            _logger.LogWarning("========================================");

            // 1. Remove persistent block filters (always try, even if state says inactive)
            try { DisablePersistentBlockInternal(); }
            catch (Exception ex) { _logger.LogError(ex, "[EMERGENCY] Failed to remove persistent block"); }

            // 2. Remove DNS leak protection
            try { DisableDnsLeakProtection(); }
            catch (Exception ex) { _logger.LogError(ex, "[EMERGENCY] Failed to remove DNS leak protection"); }

            // 3. Remove IPv6 leak protection
            try { DisableIpv6LeakProtection(); }
            catch (Exception ex) { _logger.LogError(ex, "[EMERGENCY] Failed to remove IPv6 leak protection"); }

            // 4. Remove all dynamic kill switch filters
            try { DisableInternal(); }
            catch (Exception ex) { _logger.LogError(ex, "[EMERGENCY] Failed to disable kill switch"); }

            // 5. Disable advanced mode setting so it doesn't re-activate
            _advancedConfig.AdvancedModeEnabled = false;
            _advancedConfig.AdvancedModeActive = false;
            _advancedConfig.Save();

            // 6. Emergency cleanup in WFP engine as final fallback
            try { _wfpEngine.EmergencyCleanup(); }
            catch (Exception ex) { _logger.LogError(ex, "[EMERGENCY] WFP emergency cleanup failed"); }

            _logger.LogWarning("[EMERGENCY] All filters removed. Normal internet should be restored.");
            _logger.LogWarning("========================================");
        }
    }

    /// <summary>
    /// Enable or disable the advanced kill switch setting (persisted).
    /// Does not activate/deactivate filters — just sets the preference.
    /// </summary>
    public void SetAdvancedModeEnabled(bool enabled)
    {
        lock (_lock)
        {
            _advancedConfig.AdvancedModeEnabled = enabled;
            _advancedConfig.Save();
            _logger.LogInformation("[AdvKS] Advanced mode enabled preference: {Enabled}", enabled);
        }
    }

    /// <summary>
    /// Recover persistent kill switch state on service startup.
    /// Call this after WfpEngine.Open() during service initialization.
    /// </summary>
    public void InitializeFromConfig()
    {
        lock (_lock)
        {
            _advancedConfig = AdvancedKillSwitchConfig.Load();
            _logger.LogInformation("[AdvKS] Config loaded: AdvancedModeEnabled={Enabled}, AdvancedModeActive={Active}",
                _advancedConfig.AdvancedModeEnabled, _advancedConfig.AdvancedModeActive);

            if (!_advancedConfig.AdvancedModeActive) return;

            _logger.LogInformation("[AdvKS] AdvancedModeActive=true — checking persistent filters in BFE...");

            try
            {
                bool filtersExist = _wfpEngine.ArePersistentFiltersActive();

                if (!filtersExist)
                {
                    _logger.LogWarning("[AdvKS] Persistent filters missing from BFE (BFE restart?). Re-creating...");
                    try
                    {
                        _wfpEngine.OpenPersistentSession();
                        _wfpEngine.AddPersistentBlockAllFilters();
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "[AdvKS] Failed to re-create persistent filters. Falling back to Disabled.");
                        _advancedConfig.AdvancedModeActive = false;
                        _advancedConfig.Save();
                        return;
                    }
                }
                else
                {
                    // Open persistent session so we can manage filters later
                    try { _wfpEngine.OpenPersistentSession(); } catch { /* non-fatal */ }
                }

                _persistentBlockActive = true;
                TransitionState(KillSwitchState.PersistentBlock, "InitializeFromConfig (startup recovery)");
                _logger.LogInformation("[AdvKS] Service recovered to PersistentBlock state — internet blocked until VPN connects");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[AdvKS] Error during startup recovery. Falling back to Disabled.");
                _advancedConfig.AdvancedModeActive = false;
                _advancedConfig.Save();
            }
        }
    }

    private void DisablePersistentBlockInternal()
    {
        try
        {
            _wfpEngine.RemovePersistentBlockAllFilters();
            _wfpEngine.ClosePersistentSession();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[AdvKS] Failed to remove persistent filters");
        }

        _persistentBlockActive = false;
        _advancedConfig.AdvancedModeActive = false;
        _advancedConfig.Save();

        _logger.LogInformation("[AdvKS] Persistent filters removed from BFE");
    }

    private void AddBootstrapFilters()
    {
        // Filter weights (higher = higher priority):
        // 200 - Loopback (implicit)
        // 190 - VPN server endpoint
        // 180 - LAN subnets
        // 170 - DHCP
        // 160 - DNS
        // 50  - Block IPv6
        // 10  - Block all IPv4

        // 1. Loopback permit (for localhost apps)
        var loopbackId = _wfpEngine.AddPermitLoopbackFilter("Permit Loopback", 200);
        _activeFilters.Add(loopbackId);

        // 2. VPN server endpoint with protocol/port (for tunnel handshake)
        if (!string.IsNullOrEmpty(_vpnServerIp))
        {
            try
            {
                _logger.LogInformation("Adding VPN server permit: {Ip}:{Port}", _vpnServerIp, _vpnServerPort);

                // Outbound: permit connections to VPN server
                var serverId = _wfpEngine.AddPermitVpnServerFilter(
                    $"Permit VPN Server {_vpnServerIp}:{_vpnServerPort}",
                    _vpnServerIp, _vpnServerPort, _vpnIsTcp, 190);
                _activeFilters.Add(serverId);

                // Inbound: permit responses from VPN server (required for handshake)
                var serverInboundId = _wfpEngine.AddPermitVpnServerInboundFilter(
                    $"Permit VPN Server Inbound {_vpnServerIp}",
                    _vpnServerIp, _vpnServerPort, _vpnIsTcp, 190);
                _activeFilters.Add(serverInboundId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to add VPN server permit — cannot safely bootstrap");
                throw;
            }
        }

        // 3. LAN subnets (allow local network access)
        var lanIds = _wfpEngine.AddPermitLanFilters("Permit LAN", 180);
        _activeFilters.AddRange(lanIds);

        // 4. DHCP (for network connectivity)
        var dhcpId = _wfpEngine.AddPermitDhcpFilter("Permit DHCP", 170);
        _activeFilters.Add(dhcpId);

        // 5. DNS (allow system DNS during bootstrap)
        var dnsId = _wfpEngine.AddPermitDnsFilter("Permit DNS", 160);
        _activeFilters.Add(dnsId);

        // 6. Block all IPv6 (prevent IPv6 leaks) - use dual-layer blocking
        // Track IDs for removal during EnableIpv6LeakProtection (to avoid duplicates)
        var ipv6BlockIds = _wfpEngine.AddBlockAllIpv6Filters("Block IPv6", 50);
        _bootstrapIpv6BlockFilterIds.Clear();
        _bootstrapIpv6BlockFilterIds.AddRange(ipv6BlockIds);
        _activeFilters.AddRange(ipv6BlockIds);

        // 7. Block all other IPv4 traffic (catch-all at both transport and IP packet layers)
        var blockIds = _wfpEngine.AddBlockAllFilters("Block All IPv4", 10);
        _activeFilters.AddRange(blockIds);
    }

    /// <summary>
    /// Legacy Enable method for backwards compatibility.
    /// Immediately enters Bootstrap state then transitions to Connected.
    /// </summary>
    [Obsolete("Use EnableBootstrap() and TransitionToConnected() for proper phased activation")]
    public void Enable(string vpnServerIp, int vpnInterfaceIndex = 0)
    {
        // Default to WireGuard UDP/51820
        EnableBootstrap(vpnServerIp, 51820, false);

        if (vpnInterfaceIndex > 0)
        {
            TransitionToConnected((uint)vpnInterfaceIndex);
        }
    }

    /// <summary>
    /// Update the VPN interface index (triggers transition to connected if in bootstrap)
    /// </summary>
    public void UpdateVpnInterface(int interfaceIndex)
    {
        lock (_lock)
        {
            if (_state == KillSwitchState.Bootstrap && interfaceIndex > 0)
            {
                TransitionToConnected((uint)interfaceIndex);
            }
            else if (_state == KillSwitchState.Connected)
            {
                _logger.LogInformation("VPN interface index {Index} updated (already connected)", interfaceIndex);
            }
        }
    }

    /// <summary>
    /// Enable DNS leak protection (works independently of kill switch).
    /// Forces all DNS traffic through the VPN tunnel interface.
    /// Call this after VPN tunnel is established.
    /// </summary>
    /// <param name="tunnelInterfaceIndex">VPN tunnel interface index</param>
    public void EnableDnsLeakProtection(uint tunnelInterfaceIndex)
    {
        lock (_lock)
        {
            if (_dnsLeakProtectionActive)
            {
                _logger.LogInformation("[DNS] DNS leak protection already active");
                return;
            }

            _logger.LogInformation("========================================");
            _logger.LogInformation("[DNS] Enabling DNS Leak Protection");
            _logger.LogInformation("========================================");
            _logger.LogInformation("  Tunnel Interface Index: {Index}", tunnelInterfaceIndex);
            _logger.LogInformation("[DNS] Tunnel interface is valid, proceeding with filter registration...");

            try
            {
                // Strategy: Permit DNS ONLY on tunnel interface (both directions)
                // By only permitting DNS on tunnel, traffic is naturally restricted to tunnel
                // No global block needed - DNS simply won't work on other interfaces

                _logger.LogInformation("[DNS] Step 1: Register OUTBOUND DNS permit filter");
                // 1. Permit OUTBOUND DNS queries on tunnel interface
                var dnsOutboundId = _wfpEngine.AddPermitDnsOnTunnelInterface(
                    "DNS Leak Protection - Permit outbound DNS", tunnelInterfaceIndex, 170);
                _dnsFilters.Add(dnsOutboundId);
                _logger.LogInformation("[DNS] Step 1 complete - Filter ID: {Id}", dnsOutboundId);

                _logger.LogInformation("[DNS] Step 2: Register INBOUND DNS permit filter");
                // 2. Permit INBOUND DNS responses on tunnel interface
                var dnsInboundId = _wfpEngine.AddPermitDnsInboundOnTunnelInterface(
                    "DNS Leak Protection - Permit inbound DNS", tunnelInterfaceIndex, 170);
                _dnsFilters.Add(dnsInboundId);
                _logger.LogInformation("[DNS] Step 2 complete - Filter ID: {Id}", dnsInboundId);

                _logger.LogInformation("[DNS] Step 3: Register BLOCK ALL DNS filter (IPv4)");
                // 3. CRITICAL: Block ALL DNS traffic (weight 165 < permit weight 170)
                // This ensures DNS queries are blocked UNLESS they match the permit filter above
                var dnsBlockIdV4 = _wfpEngine.AddBlockAllDns(
                    "DNS Leak Protection - Block all DNS", 165);
                _dnsFilters.Add(dnsBlockIdV4);
                _logger.LogInformation("[DNS] Step 3 complete - Filter ID: {Id}", dnsBlockIdV4);

                _logger.LogInformation("[DNS] Step 4: Register BLOCK ALL DNS filter (IPv6)");
                // 4. Block ALL IPv6 DNS traffic (weight 165)
                var dnsBlockIdV6 = _wfpEngine.AddBlockAllDnsV6(
                    "DNS Leak Protection - Block all DNS v6", 165);
                _dnsFilters.Add(dnsBlockIdV6);
                _logger.LogInformation("[DNS] Step 4 complete - Filter ID: {Id}", dnsBlockIdV6);

                _dnsLeakProtectionActive = true;

                _logger.LogInformation("----------------------------------------");
                _logger.LogInformation("[DNS] ✓ DNS Leak Protection ENABLED SUCCESSFULLY");
                _logger.LogInformation("  Total filters registered: {Count}", _dnsFilters.Count);
                _logger.LogInformation("  Filter IDs: {Ids}", string.Join(", ", _dnsFilters));
                _logger.LogInformation("  Strategy: Block ALL DNS, then permit DNS ONLY on tunnel interface");
                _logger.LogInformation("  Weight 170 (Permit on tunnel) > Weight 165 (Block all)");
                _logger.LogInformation("  - Outbound DNS (UDP/53) on tunnel: PERMIT (weight 170)");
                _logger.LogInformation("  - Inbound DNS responses on tunnel: PERMIT (weight 170)");
                _logger.LogInformation("  - ALL DNS traffic everywhere: BLOCK (weight 165)");
                _logger.LogInformation("  - Result: DNS only works through tunnel interface");
                _logger.LogInformation("[DNS] ✓ DNS traffic restricted to VPN tunnel only (works without kill switch)");
                _logger.LogInformation("========================================");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[DNS] ✗ FAILED to enable DNS leak protection");
                _logger.LogError("[DNS] Exception details: {Message}", ex.Message);
                if (ex.InnerException != null)
                {
                    _logger.LogError("[DNS] Inner exception: {InnerMessage}", ex.InnerException.Message);
                }
                _logger.LogError("[DNS] Cleaning up any partially-added filters...");
                DisableDnsLeakProtection();
                throw;
            }
        }
    }

    /// <summary>
    /// Disable DNS leak protection and restore normal DNS routing.
    /// </summary>
    public void DisableDnsLeakProtection()
    {
        lock (_lock)
        {
            if (!_dnsLeakProtectionActive && _dnsFilters.Count == 0)
            {
                return;
            }

            _logger.LogInformation("========================================");
            _logger.LogInformation("[DNS] Disabling DNS Leak Protection");
            _logger.LogInformation("========================================");

            int removed = 0;
            foreach (var filterId in _dnsFilters)
            {
                try
                {
                    if (filterId != 0)
                    {
                        _wfpEngine.RemoveFilter(filterId);
                        removed++;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[DNS] Failed to remove filter {Id}", filterId);
                }
            }

            _dnsFilters.Clear();
            _dnsLeakProtectionActive = false;

            _logger.LogInformation("[DNS] DNS Leak Protection DISABLED - {Count} filters removed", removed);
            _logger.LogInformation("========================================");
        }
    }

    /// <summary>
    /// Disable IPv6 leak protection and restore normal IPv6 routing.
    /// </summary>
    public void DisableIpv6LeakProtection()
    {
        lock (_lock)
        {
            if (!_ipv6LeakProtectionActive && _ipv6Filters.Count == 0)
            {
                return;
            }

            _logger.LogInformation("========================================");
            _logger.LogInformation("[IPv6] Disabling IPv6 Leak Protection");
            _logger.LogInformation("========================================");

            int removed = 0;
            foreach (var filterId in _ipv6Filters)
            {
                try
                {
                    if (filterId != 0)
                    {
                        _wfpEngine.RemoveFilter(filterId);
                        removed++;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[IPv6] Failed to remove filter {Id}", filterId);
                }
            }

            _ipv6Filters.Clear();
            _ipv6LeakProtectionActive = false;

            _logger.LogInformation("[IPv6] IPv6 Leak Protection DISABLED - {Count} filters removed", removed);
            _logger.LogInformation("========================================");
        }
    }

    /// <summary>
    /// Enable IPv6 leak protection with conditional tunnel support.
    /// If tunnel supports IPv6, routes IPv6 through tunnel. Otherwise blocks IPv6 entirely.
    /// Always called after VPN connection is established.
    /// </summary>
    /// <param name="tunnelInterfaceIndex">VPN tunnel interface index</param>
    /// <param name="tunnelHasIpv6">True if tunnel has IPv6 support, false to block IPv6</param>
    /// <param name="skipBlock">When true, skip the IPv6 block filter (for split tunneling — apps need physical IPv6)</param>
    public void EnableIpv6LeakProtection(uint tunnelInterfaceIndex, bool tunnelHasIpv6, bool skipBlock = false)
    {
        lock (_lock)
        {
            if (_ipv6LeakProtectionActive)
            {
                _logger.LogInformation("[IPv6] IPv6 leak protection already active");
                return;
            }

            _logger.LogInformation("========================================");
            _logger.LogInformation("[IPv6] Enabling IPv6 Leak Protection");
            _logger.LogInformation("========================================");
            _logger.LogInformation("  Tunnel Interface Index: {Index}", tunnelInterfaceIndex);
            _logger.LogInformation("  Tunnel Supports IPv6: {HasIpv6}", tunnelHasIpv6);

            try
            {
                // Remove bootstrap IPv6 block filters if they exist (avoid duplicates)
                // These filters were added by EnableBootstrap() and we're replacing them with IPv6 leak protection
                if (_bootstrapIpv6BlockFilterIds.Count > 0 && _state == KillSwitchState.Connected)
                {
                    foreach (var filterId in _bootstrapIpv6BlockFilterIds)
                    {
                        try
                        {
                            _wfpEngine.RemoveFilter(filterId);
                            _activeFilters.Remove(filterId);
                            _logger.LogInformation("[IPv6] Removed bootstrap IPv6 block filter (ID: {Id})", filterId);
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "[IPv6] Failed to remove bootstrap IPv6 block filter {Id}", filterId);
                        }
                    }
                    _bootstrapIpv6BlockFilterIds.Clear();
                }

                if (tunnelHasIpv6)
                {
                    _logger.LogInformation("[IPv6] Tunnel supports IPv6 - routing through tunnel");

                    // 1. Permit IPv6 traffic on tunnel interface (weight 250 - highest priority)
                    _logger.LogInformation("[IPv6] Step 1: Permit IPv6 on tunnel interface");
                    var tunnelIdV6 = _wfpEngine.AddPermitTunnelInterfaceFilterV6(
                        "IPv6 Leak Protection - Permit tunnel interface", tunnelInterfaceIndex, 250);
                    _ipv6Filters.Add(tunnelIdV6);
                    _logger.LogInformation("[IPv6] Step 1 complete - Filter ID: {Id}", tunnelIdV6);

                    // 1.5. Permit IPv6 loopback traffic (weight 200 - higher than block, for localhost)
                    _logger.LogInformation("[IPv6] Step 1.5: Permit IPv6 loopback (localhost)");
                    var loopbackIdV6 = _wfpEngine.AddPermitLoopbackIpv6Filter(
                        "IPv6 Leak Protection - Permit loopback", 200);
                    _ipv6Filters.Add(loopbackIdV6);
                    _logger.LogInformation("[IPv6] Step 1.5 complete - Filter ID: {Id}", loopbackIdV6);

                    // 2. Block all other IPv6 traffic (weight 50 - low priority, caught by permit above)
                    //    Skip when split tunneling is active — split-tunneled apps need physical IPv6 access
                    if (skipBlock)
                    {
                        _logger.LogInformation("[IPv6] Step 2: SKIPPED — split tunneling active, physical IPv6 needed");
                    }
                    else
                    {
                        _logger.LogInformation("[IPv6] Step 2: Block all other IPv6 traffic");
                        var blockIdV6 = _wfpEngine.AddBlockAllIpv6Filter(
                            "IPv6 Leak Protection - Block except tunnel", 50);
                        _ipv6Filters.Add(blockIdV6);
                        _logger.LogInformation("[IPv6] Step 2 complete - Filter ID: {Id}", blockIdV6);
                    }

                    // 3. Permit IPv6 DNS on tunnel (weight 170)
                    _logger.LogInformation("[IPv6] Step 3: Permit IPv6 DNS on tunnel");
                    var dnsPermitIdV6 = _wfpEngine.AddPermitDnsOnTunnelInterfaceV6(
                        "IPv6 Leak Protection - Permit DNS on tunnel", tunnelInterfaceIndex, 170);
                    _ipv6Filters.Add(dnsPermitIdV6);
                    _logger.LogInformation("[IPv6] Step 3 complete - Filter ID: {Id}", dnsPermitIdV6);

                    // 4. Block IPv6 DNS on other interfaces (weight 165)
                    //    Skip when split tunneling is active — same reason as step 2
                    if (skipBlock)
                    {
                        _logger.LogInformation("[IPv6] Step 4: SKIPPED — split tunneling active");
                    }
                    else
                    {
                        _logger.LogInformation("[IPv6] Step 4: Block IPv6 DNS on other interfaces");
                        var dnsBlockIdV6 = _wfpEngine.AddBlockAllDnsV6(
                            "IPv6 Leak Protection - Block DNS except tunnel", 165);
                        _ipv6Filters.Add(dnsBlockIdV6);
                        _logger.LogInformation("[IPv6] Step 4 complete - Filter ID: {Id}", dnsBlockIdV6);
                    }

                    _ipv6LeakProtectionActive = true;

                    _logger.LogInformation("----------------------------------------");
                    _logger.LogInformation("[IPv6] ✓ IPv6 Tunnel Support ENABLED");
                    _logger.LogInformation("  Strategy: Route IPv6 through tunnel with DNS leak protection");
                    _logger.LogInformation("  - IPv6 traffic on tunnel: PERMIT (weight 250)");
                    _logger.LogInformation("  - IPv6 loopback (localhost): PERMIT (weight 200)");
                    _logger.LogInformation("  - IPv6 traffic elsewhere: BLOCK (weight 50)");
                    _logger.LogInformation("  - IPv6 DNS on tunnel: PERMIT (weight 170)");
                    _logger.LogInformation("  - IPv6 DNS elsewhere: BLOCK (weight 165)");
                    _logger.LogInformation("  - Result: All IPv6 flows through VPN tunnel (localhost allowed)");
                }
                else
                {
                    _logger.LogInformation("[IPv6] Tunnel does NOT support IPv6 - blocking entirely");

                    // 1. Permit IPv6 loopback traffic (weight 200 - for localhost apps)
                    _logger.LogInformation("[IPv6] Step 1: Permit IPv6 loopback (localhost)");
                    var loopbackIdV6 = _wfpEngine.AddPermitLoopbackIpv6Filter(
                        "IPv6 Leak Protection - Permit loopback", 200);
                    _ipv6Filters.Add(loopbackIdV6);
                    _logger.LogInformation("[IPv6] Step 1 complete - Filter ID: {Id}", loopbackIdV6);

                    // 2. Block all other IPv6 traffic (weight 50)
                    //    Skip when split tunneling is active — split-tunneled apps need physical IPv6 access
                    if (skipBlock)
                    {
                        _logger.LogInformation("[IPv6] Step 2: SKIPPED — split tunneling active, physical IPv6 needed");
                    }
                    else
                    {
                        _logger.LogInformation("[IPv6] Step 2: Block all IPv6 traffic");
                        var blockIdV6 = _wfpEngine.AddBlockAllIpv6Filter(
                            "IPv6 Leak Protection - Block all IPv6", 50);
                        _ipv6Filters.Add(blockIdV6);
                        _logger.LogInformation("[IPv6] Step 2 complete - Filter ID: {Id}", blockIdV6);
                    }

                    _ipv6LeakProtectionActive = true;

                    _logger.LogInformation("----------------------------------------");
                    _logger.LogInformation("[IPv6] ✓ IPv6 BLOCKED (tunnel doesn't support IPv6)");
                    _logger.LogInformation("  Strategy: Block all IPv6 to prevent leaks");
                    _logger.LogInformation("  - IPv6 loopback (localhost): PERMIT (weight 200)");
                    _logger.LogInformation("  - All other IPv6 traffic: {Action} (weight 50)", skipBlock ? "ALLOWED (split tunnel)" : "BLOCK");
                    _logger.LogInformation("  - Result: {Result}", skipBlock ? "Physical IPv6 available for split-tunneled apps" : "No IPv6 leaks, localhost still works");
                }

                _logger.LogInformation("========================================");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[IPv6] ✗ FAILED to enable IPv6 leak protection");
                _logger.LogError("[IPv6] Exception details: {Message}", ex.Message);
                // Clean up any partially-added filters
                DisableIpv6LeakProtection();
                throw;
            }
        }
    }

    /// <summary>
    /// Dump all IPv6-related filter info for diagnostics.
    /// </summary>
    public void DumpIpv6FilterInfo()
    {
        lock (_lock)
        {
            _logger.LogInformation("[DIAG] IPv6 leak protection active: {Active}", _ipv6LeakProtectionActive);
            _logger.LogInformation("[DIAG] IPv6 filter IDs ({Count}): {Ids}",
                _ipv6Filters.Count, string.Join(", ", _ipv6Filters));
            _logger.LogInformation("[DIAG] Kill switch filter IDs ({Count}): {Ids}",
                _activeFilters.Count, string.Join(", ", _activeFilters));
            _logger.LogInformation("[DIAG] Bootstrap IPv6 block filter IDs ({Count}): {Ids}",
                _bootstrapIpv6BlockFilterIds.Count, string.Join(", ", _bootstrapIpv6BlockFilterIds));
            _logger.LogInformation("[DIAG] DNS filter IDs ({Count}): {Ids}",
                _dnsFilters.Count, string.Join(", ", _dnsFilters));
        }
    }

    /// <summary>
    /// Permit IPv6 traffic on the physical adapter interface for split-tunneled apps.
    /// Called when app-based split tunneling is active so that excluded apps can use
    /// IPv6 through the physical adapter without being blocked by IPv6 leak protection.
    /// </summary>
    public void AddIpv6SplitTunnelPermit(uint physicalInterfaceIndex)
    {
        lock (_lock)
        {
            if (!_ipv6LeakProtectionActive)
            {
                _logger.LogInformation("[IPv6] No IPv6 leak protection active — split tunnel permit not needed");
                return;
            }

            try
            {
                var permitId = _wfpEngine.AddPermitTunnelInterfaceFilterV6(
                    $"IPv6 Split Tunnel - Permit physical interface {physicalInterfaceIndex}",
                    physicalInterfaceIndex, 250);
                _ipv6Filters.Add(permitId);
                _logger.LogInformation("[IPv6] Split tunnel permit added for physical interface {Index} (filter ID: {Id})",
                    physicalInterfaceIndex, permitId);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[IPv6] Failed to add split tunnel permit for physical interface");
            }
        }
    }

    /// <summary>
    /// Dump current DNS filter statistics for debugging traffic flow
    /// Call this after running DNS queries to see filter hit counts
    /// </summary>
    public void DumpDnsFilterStats()
    {
        lock (_lock)
        {
            if (_dnsFilters.Count == 0)
            {
                _logger.LogWarning("[STATS] No DNS filters registered");
                return;
            }

            _logger.LogInformation("[STATS] Dumping statistics for {Count} DNS filters", _dnsFilters.Count);
            _wfpEngine.DumpDnsFilterStatistics(_dnsFilters);
        }
    }

    /// <summary>
    /// Helper: transitions state and logs the change with a timestamp.
    /// Must be called inside _lock.
    /// </summary>
    private void TransitionState(KillSwitchState newState, string reason)
    {
        var from = _state;
        _state = newState;
        _logger.LogInformation("[STATE TRANSITION] {From} → {To} | {Reason} | {Timestamp:O}",
            from, newState, reason, DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// Returns a diagnostic snapshot of the kill switch state and filter counts.
    /// Used by the getDiagnostics JSON-RPC method.
    /// </summary>
    public object GetDiagnostics()
    {
        lock (_lock)
        {
            return new
            {
                timestamp = DateTimeOffset.UtcNow,
                state = _state.ToString(),
                killSwitchEnabled = IsEnabled,
                advancedModeEnabled = _advancedConfig.AdvancedModeEnabled,
                advancedModeActive = _persistentBlockActive,
                persistentFiltersInBfe = _wfpEngine.ArePersistentFiltersActive(),
                dynamicFilterCount = _activeFilters.Count,
                dnsFilterCount = _dnsFilters.Count,
                ipv6FilterCount = _ipv6Filters.Count,
                physicalPermitCount = _physicalInterfaceFilterIds.Count,
                splitTunnelIpPermitCount = _splitTunnelIpFilterIds.Count,
                dnsLeakProtectionActive = _dnsLeakProtectionActive,
                ipv6LeakProtectionActive = _ipv6LeakProtectionActive,
            };
        }
    }
}
