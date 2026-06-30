using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using WireDog.Service.Firewall;
using WireDog.Service.KillSwitch;
using WireDog.Service.SplitTunnel;
using WireDog.Service.Tunnel;
using KillSwitchStateEnum = WireDog.Service.KillSwitch.KillSwitchState;

namespace WireDog.Service.Ipc;

/// <summary>
/// Handles JSON-RPC method calls
/// </summary>
public class JsonRpcHandler
{
    private readonly ILogger<JsonRpcHandler> _logger;
    private readonly KillSwitchManager _killSwitch;
    private readonly WireGuardManager _wireGuard;
    private readonly ConnectionStateManager _connectionState;
    private readonly NetshFirewallManager _firewallManager;
    private readonly SplitTunnelManager _splitTunnel;
    private readonly ServiceConfiguration _config;
    private readonly Stopwatch _uptime = Stopwatch.StartNew();

    // SPLIT_TUNNEL_DISABLED: Set to true when EV certificate is obtained. See docs/SPLIT_TUNNEL_REINSTATE.md.
    private const bool SplitTunnelEnabled = false;

    // Rate limiting: track call timestamps per method to prevent IPC flooding
    private const int RateLimitMaxCalls = 10;
    private static readonly TimeSpan RateLimitWindow = TimeSpan.FromMinutes(1);
    private readonly ConcurrentDictionary<string, Queue<DateTime>> _methodCallTimes = new();
    private static readonly HashSet<string> RateLimitedMethods = new(StringComparer.Ordinal)
    {
        "connect", "disconnect", "emergencyReset",
        "enableKillSwitch", "disableKillSwitch",
        "enableAdvancedKillSwitch", "disableAdvancedKillSwitch"
    };

    // Track current server IP for cleanup
    private string? _currentServerIp;

    // Auto-reconnect: store last connect params in memory for reconnect on connection drop
    private ConnectParams? _lastConnectParams;
    private CancellationTokenSource? _reconnectCts;

    /// <summary>
    /// Event fired when a notification should be broadcast to all clients
    /// </summary>
    public event Func<JsonRpcNotification, Task>? NotificationRequested;

    public JsonRpcHandler(
        ILogger<JsonRpcHandler> logger,
        KillSwitchManager killSwitch,
        WireGuardManager wireGuard,
        ConnectionStateManager connectionState,
        NetshFirewallManager firewallManager,
        SplitTunnelManager splitTunnel,
        ServiceConfiguration config)
    {
        _logger = logger;
        _killSwitch = killSwitch;
        _wireGuard = wireGuard;
        _connectionState = connectionState;
        _firewallManager = firewallManager;
        _splitTunnel = splitTunnel;
        _config = config;

        // Subscribe to state changes
        _connectionState.StateChanged += OnStateChanged;

        // Subscribe to connection lost events for kill switch transition
        _wireGuard.ConnectionLost += OnConnectionLost;
    }

    /// <summary>
    /// Called by Worker on service startup. If always-on KS was active and we have
    /// a persisted connection config, attempt to reconnect in the background.
    /// This establishes the tunnel before Windows login prompt, preventing lockout.
    /// </summary>
    public void TryAutoReconnectOnStartup()
    {
        if (!_killSwitch.IsAdvancedModeActive)
        {
            _logger.LogInformation("[BootReconnect] Advanced KS not active — skipping boot reconnect");
            return;
        }

        var config = AutoReconnectConfig.Load();
        if (config?.Config == null)
        {
            _logger.LogWarning("[BootReconnect] No persisted connection config found — staying in PersistentBlock");
            return;
        }

        _logger.LogInformation("[BootReconnect] Found persisted config for server {ServerId} — starting boot reconnect",
            config.ServerId);

        var connectParams = config.ToConnectParams();
        _reconnectCts?.Cancel();
        _reconnectCts = new CancellationTokenSource();
        var cts = _reconnectCts;

        _ = Task.Run(async () =>
        {
            // Transition from PersistentBlock to Bootstrap so VPN server traffic is allowed
            _logger.LogInformation("[BootReconnect] Transitioning from PersistentBlock to Bootstrap...");
            _killSwitch.DisablePersistentBlock();

            var endpoint = connectParams.Config!.Endpoint.Split(':');
            var serverHost = endpoint[0];
            var serverPort = endpoint.Length > 1 && ushort.TryParse(endpoint[1], out var port) ? port : (ushort)443;
            _killSwitch.EnableBootstrap(serverHost, serverPort, isTcp: false);

            // Retry loop with same backoff as connection-drop auto-reconnect
            for (int attempt = 1; attempt <= AutoReconnectDelaysMs.Length; attempt++)
            {
                if (cts.Token.IsCancellationRequested) return;

                int delayMs = AutoReconnectDelaysMs[attempt - 1];
                _logger.LogInformation("[BootReconnect] Waiting {Delay}s before attempt {Attempt}/{Total}...",
                    delayMs / 1000, attempt, AutoReconnectDelaysMs.Length);
                try { await Task.Delay(delayMs, cts.Token); }
                catch (OperationCanceledException) { return; }

                if (cts.Token.IsCancellationRequested) return;

                try
                {
                    var fakeRequest = new JsonRpcRequest { Method = "connect", Params = connectParams };
                    await HandleConnectAsync(fakeRequest, cts.Token);
                    _logger.LogInformation("[BootReconnect] Connected successfully on attempt {Attempt}!", attempt);
                    return;
                }
                catch (OperationCanceledException) { return; }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[BootReconnect] Attempt {Attempt} failed", attempt);
                }
            }

            // All attempts failed — re-enable PersistentBlock
            _logger.LogWarning("[BootReconnect] All attempts exhausted — re-enabling PersistentBlock");
            _killSwitch.EnablePersistentBlock();
            _connectionState.SetError("Boot reconnect failed — internet blocked for protection. Open WireDog to reconnect.");
        });
    }

    private void OnConnectionLost(object? sender, EventArgs e)
    {
        _logger.LogWarning("########################################");
        _logger.LogWarning("#  CONNECTION LOST DETECTED!           #");
        _logger.LogWarning("########################################");
        _logger.LogInformation("  Current Kill Switch State: {State}", _killSwitch.State);

        if (_killSwitch.State == KillSwitchStateEnum.Connected)
        {
            // Kill switch active: transition to Bootstrap to maintain protection while allowing reconnect
            _logger.LogInformation("  Action: Transition to Bootstrap for reconnection");
            _killSwitch.TransitionToBootstrap();

            // Remove DNS/IPv6 leak protection — their filters (weight 165 BLOCK) override
            // Bootstrap's DNS permit (weight 160), preventing DNS resolution during reconnect.
            _killSwitch.DisableDnsLeakProtection();
            _killSwitch.DisableIpv6LeakProtection();

            _connectionState.SetError("Connection lost - reconnecting...");

            // Auto-reconnect: always attempt when kill switch is active and we have stored params.
            // Note: WireGuard's InstallAndStart already stops any stale service,
            // so we don't need to disconnect here (which would remove the adapter).
            if (_lastConnectParams != null)
            {
                var paramsForReconnect = _lastConnectParams;
                _reconnectCts?.Cancel();
                _reconnectCts = new CancellationTokenSource();
                var cts = _reconnectCts;
                _ = Task.Run(() => AutoReconnectAsync(paramsForReconnect, cts.Token));
            }
        }
        else
        {
            // No kill switch: full cleanup so internet resumes on physical adapter
            _logger.LogInformation("  Action: No kill switch — full cleanup to restore internet");
            _ = Task.Run(async () =>
            {
                try
                {
                    // Clean up split tunneling
                    try { _splitTunnel.DisableAppSplitTunneling(); }
                    catch (Exception ex) { _logger.LogWarning(ex, "[CONNECTION LOST] App split tunnel cleanup error"); }
                    try { _splitTunnel.DisableIpSplitTunneling(); }
                    catch (Exception ex) { _logger.LogWarning(ex, "[CONNECTION LOST] IP split tunnel cleanup error"); }

                    // Clean up DNS/IPv6 leak protection
                    _killSwitch.DisableDnsLeakProtection();
                    _killSwitch.DisableIpv6LeakProtection();

                    // Stop WireGuard tunnel service (removes routes)
                    await _wireGuard.DisconnectAsync(CancellationToken.None);

                    // Clean up server firewall rule
                    if (_currentServerIp != null)
                    {
                        _firewallManager.RemoveServerRule(_currentServerIp);
                        _currentServerIp = null;
                    }

                    _lastConnectParams = null;
                    _connectionState.SetDisconnected();
                    _logger.LogInformation("[CONNECTION LOST] Cleanup complete — internet should be restored");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[CONNECTION LOST] Cleanup failed");
                    _connectionState.SetError("Connection lost - cleanup failed");
                }
            });
        }
    }

    private async void OnStateChanged(object? sender, ConnectionState state)
    {
        try
        {
            var notification = new JsonRpcNotification
            {
                Method = "status_changed",
                Params = new StatusChangedParams
                {
                    State = state.Status.ToString().ToLowerInvariant(),
                    KillSwitchActive = _killSwitch.IsEnabled,
                    KillSwitchState = _killSwitch.State.ToString().ToLowerInvariant(),
                    AssignedIp = state.AssignedIp,
                    Error = state.Error,
                    AdvancedKillSwitchEnabled = _killSwitch.IsAdvancedModeEnabled,
                    AdvancedKillSwitchActive = _killSwitch.IsAdvancedModeActive
                }
            };

            if (NotificationRequested != null)
            {
                await NotificationRequested.Invoke(notification);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to broadcast state change");
        }
    }

    public async Task<string?> HandleAsync(string message, CancellationToken cancellationToken)
    {
        JsonRpcRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<JsonRpcRequest>(message);
            if (request == null)
            {
                return Serialize(JsonRpcResponse.Failure(null, JsonRpcErrorCodes.InvalidRequest, "Invalid request"));
            }
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to parse JSON-RPC request");
            return Serialize(JsonRpcResponse.Failure(null, JsonRpcErrorCodes.ParseError, "Parse error"));
        }

        // If no id, it's a notification - no response needed
        if (request.Id == null)
        {
            await HandleNotificationAsync(request, cancellationToken);
            return null;
        }

        try
        {
            var result = await HandleMethodAsync(request, cancellationToken);
            return Serialize(JsonRpcResponse.Success(request.Id, result));
        }
        catch (JsonRpcException ex)
        {
            return Serialize(JsonRpcResponse.Failure(request.Id, ex.Code, ex.Message, ex.Data));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error handling method {Method}", request.Method);
            return Serialize(JsonRpcResponse.Failure(request.Id, JsonRpcErrorCodes.InternalError, "Internal error"));
        }
    }

    private async Task<object?> HandleMethodAsync(JsonRpcRequest request, CancellationToken cancellationToken)
    {
        // Rate limit sensitive methods to prevent IPC flooding
        if (RateLimitedMethods.Contains(request.Method))
        {
            var now = DateTime.UtcNow;
            var times = _methodCallTimes.GetOrAdd(request.Method, _ => new Queue<DateTime>());
            lock (times)
            {
                // Remove expired entries
                while (times.Count > 0 && now - times.Peek() > RateLimitWindow)
                    times.Dequeue();

                if (times.Count >= RateLimitMaxCalls)
                {
                    _logger.LogWarning("[RateLimit] Method {Method} exceeded {Limit} calls/min", request.Method, RateLimitMaxCalls);
                    throw new JsonRpcException(JsonRpcErrorCodes.InternalError, "Rate limit exceeded — try again later");
                }

                times.Enqueue(now);
            }
        }

        return request.Method switch
        {
            "ping" => HandlePing(),
            "connect" => await HandleConnectAsync(request, cancellationToken),
            "disconnect" => await HandleDisconnectAsync(request, cancellationToken),
            "getStatus" => HandleGetStatus(),
            "getStats" => await HandleGetStatsAsync(cancellationToken),
            "getConfig" => HandleGetConfig(),
            "enableKillSwitch" => HandleEnableKillSwitch(request),
            "disableKillSwitch" => HandleDisableKillSwitch(),
            "enableAdvancedKillSwitch" => HandleEnableAdvancedKillSwitch(),
            "disableAdvancedKillSwitch" => HandleDisableAdvancedKillSwitch(),
            "getDnsFilterStats" => HandleGetDnsFilterStats(),
            "getDiagnostics" => HandleGetDiagnostics(),
            "emergencyReset" => await HandleEmergencyResetAsync(cancellationToken),
            _ => throw new JsonRpcException(JsonRpcErrorCodes.MethodNotFound, $"Method not found: {request.Method}")
        };
    }

    private Task HandleNotificationAsync(JsonRpcRequest request, CancellationToken cancellationToken)
    {
        _logger.LogDebug("Received notification: {Method}", request.Method);
        return Task.CompletedTask;
    }

    private PingResult HandlePing()
    {
        return new PingResult
        {
            Version = "1.0.0",
            Uptime = _uptime.ElapsedMilliseconds
        };
    }

    private ConfigResult HandleGetConfig()
    {
        return new ConfigResult
        {
            LocalMode = _config.IsLocalMode,
            DevMode = _config.IsDevMode,
            PipeName = _config.PipeName
        };
    }

    private async Task<ConnectResult> HandleConnectAsync(JsonRpcRequest request, CancellationToken cancellationToken)
    {
        if (_connectionState.Current.Status == ConnectionStatus.Connected)
        {
            throw new JsonRpcException(JsonRpcErrorCodes.AlreadyConnected, "Already connected");
        }

        var paramsJson = JsonSerializer.Serialize(request.Params);
        var connectParams = JsonSerializer.Deserialize<ConnectParams>(paramsJson)
            ?? throw new JsonRpcException(JsonRpcErrorCodes.InvalidParams, "Invalid connect parameters");

        if (connectParams.Config == null)
        {
            throw new JsonRpcException(JsonRpcErrorCodes.InvalidParams, "Config is required");
        }

        _connectionState.SetConnecting(connectParams.ServerId);

        _logger.LogInformation("****************************************");
        _logger.LogInformation("*  VPN CONNECTION SEQUENCE STARTING    *");
        _logger.LogInformation("****************************************");
        _logger.LogInformation("  Server: {ServerId}", connectParams.ServerId);
        _logger.LogInformation("  Endpoint: {Endpoint}", connectParams.Config.Endpoint);
        _logger.LogInformation("  Kill Switch: {Enabled}", connectParams.KillSwitch ? "YES" : "NO");

        try
        {
            // Extract server info from endpoint
            var endpoint = connectParams.Config.Endpoint.Split(':');
            var serverHost = endpoint[0];
            var serverPort = endpoint.Length > 1 && ushort.TryParse(endpoint[1], out var port) ? port : (ushort)443;

            // PHASE 1: Enable kill switch BEFORE DNS resolution to close the pre-DNS traffic gap.
            // Bootstrap permits DNS traffic, so resolution will succeed even with kill switch active.
            if (connectParams.KillSwitch)
            {
                _logger.LogInformation("----------------------------------------");
                _logger.LogInformation("[STEP 1/3] Enabling Kill Switch Bootstrap (pre-DNS)...");
                _logger.LogInformation("  (This happens BEFORE DNS resolution and WireGuard connects)");

                // Enable bootstrap without server IP yet — DNS permit in bootstrap allows hostname resolution.
                // Server IP will be added after DNS resolves via UpdateBootstrapServerPermit().
                string bootstrapIp = IPAddress.TryParse(serverHost, out _) ? serverHost : "";
                _killSwitch.EnableBootstrap(bootstrapIp, serverPort, isTcp: false);
            }
            else
            {
                _logger.LogInformation("[STEP 1/3] Kill Switch: SKIPPED (not enabled)");
            }

            // Resolve hostname to IP address if needed (kill switch DNS permit allows this through)
            string serverIp = serverHost;
            if (!IPAddress.TryParse(serverHost, out _))
            {
                // It's a hostname, resolve it to IP
                _logger.LogInformation("[DNS] Resolving hostname: {Hostname}", serverHost);
                try
                {
                    var addresses = await Dns.GetHostAddressesAsync(serverHost, cancellationToken);
                    var ipv4 = addresses.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork);
                    if (ipv4 != null)
                    {
                        serverIp = ipv4.ToString();
                        _logger.LogInformation("[DNS] Resolved {Hostname} -> {Ip}", serverHost, serverIp);

                        // Now add the VPN server permit with the resolved IP
                        if (connectParams.KillSwitch)
                        {
                            _killSwitch.UpdateBootstrapServerPermit(serverIp, serverPort, isTcp: false);
                        }
                    }
                    else
                    {
                        _logger.LogWarning("[DNS] No IPv4 address found for {Hostname}, using hostname as-is", serverHost);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[DNS] Failed to resolve {Hostname}, using hostname as-is", serverHost);
                }
            }

            // PHASE 0: Add persistent firewall rule for this specific server
            _logger.LogInformation("----------------------------------------");
            _logger.LogInformation("[STEP 0/3] Adding server firewall rule...");
            _firewallManager.AddServerRule(serverIp, serverPort, isTcp: false);
            _currentServerIp = serverIp;

            // PHASE 1.5: Always rewrite /0 AllowedIPs → /1 pairs to disable AWG's built-in WFP
            // kill-switch. AWG activates its own block-all WFP firewall when AllowedIPs contains /0.
            // Using /1 pairs gives identical routing coverage without triggering AWG's WFP block.
            // WireDog's own WFP rules (DNS leak protection, IPv6 protection, kill switch) handle
            // leak protection instead.
            bool stripIpv6 = false;
            if (SplitTunnelEnabled && connectParams.SplitTunneling is { Enabled: true })
            {
                _logger.LogInformation("[SPLIT TUNNEL] Enabled, mode={Mode}, apps={AppCount}, ips={IpCount}",
                    connectParams.SplitTunneling.Mode,
                    connectParams.SplitTunneling.Apps.Count,
                    connectParams.SplitTunneling.Ips.Count);

                // In exclude mode with app rules, also strip ALL IPv6 entries from AllowedIPs
                // so AWG doesn't create ::/1 routes. Excluded apps use physical IPv6 directly.
                bool hasAppRules = _splitTunnel.HasAppRules(connectParams.SplitTunneling);
                if (hasAppRules && connectParams.SplitTunneling.Mode == "exclude")
                    stripIpv6 = true;
            }
            connectParams.Config.AllowedIPs = RewriteAllowedIPsForSplitTunnel(
                connectParams.Config.AllowedIPs, stripIpv6: stripIpv6);

            // PHASE 2: Connect WireGuard (now protected by bootstrap kill switch)
            _logger.LogInformation("----------------------------------------");
            _logger.LogInformation("[STEP 2/3] Connecting WireGuard Tunnel...");
            _logger.LogInformation("  (Traffic is now protected by bootstrap filters)");

            // Update the endpoint with the resolved IP (WireGuard P/Invoke requires IP, not hostname)
            connectParams.Config.Endpoint = $"{serverIp}:{serverPort}";

            var result = await _wireGuard.ConnectAsync(connectParams.Config, cancellationToken);

            _logger.LogInformation("[STEP 2/3] WireGuard tunnel UP! IP: {Ip}", result.AssignedIp);

            // Check handshake status (for debugging)
            _logger.LogInformation("[STEP 2/3] Checking WireGuard handshake status...");
            await Task.Delay(2000, cancellationToken); // Give time for handshake
            await _wireGuard.CheckHandshakeStatusAsync(cancellationToken);

            // Get tunnel interface index early (needed by both split tunneling and protections)
            var interfaceIndex = await _wireGuard.GetInterfaceIndexAsync(cancellationToken);

            // PHASE 2.5: Enable app-based split tunneling via callout driver (after tunnel is up)
            if (SplitTunnelEnabled && _splitTunnel.HasAppRules(connectParams.SplitTunneling))
            {
                _logger.LogInformation("[SPLIT TUNNEL] Engaging callout driver for app-based split tunneling...");
                try
                {
                    // Get the physical adapter IPs (default gateway adapter)
                    var (physicalIp, physicalIpV6) = GetPhysicalAdapterIp();
                    var tunnelIp = result.AssignedIp ?? connectParams.Config.Address?.Split('/')[0] ?? "";

                    if (!string.IsNullOrEmpty(physicalIp) && !string.IsNullOrEmpty(tunnelIp))
                    {
                        var driverOk = _splitTunnel.EnableAppSplitTunneling(
                            connectParams.SplitTunneling!, tunnelIp, physicalIp, physicalIpV6, interfaceIndex);

                        if (driverOk)
                        {
                            _logger.LogInformation("[SPLIT TUNNEL] Callout driver engaged: tunnel={TunnelIp}, physical={PhysicalIp}, physicalV6={PhysicalIpV6}",
                                tunnelIp, physicalIp, physicalIpV6 ?? "none");
                        }
                        else
                        {
                            _logger.LogWarning("[SPLIT TUNNEL] Callout driver not available — app-based split tunneling disabled. Is the driver installed?");
                        }
                    }
                    else
                    {
                        _logger.LogWarning("[SPLIT TUNNEL] Could not determine adapter IPs — app-based split tunneling disabled");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[SPLIT TUNNEL] Failed to enable app-based split tunneling — continuing without it");
                }
            }

            // PHASE 3: Enable protections after tunnel is up
            _logger.LogInformation("----------------------------------------");
            _logger.LogInformation("[STEP 3/3] Enabling VPN Protections...");

            // 3a. Transition kill switch to connected state (if enabled)
            if (connectParams.KillSwitch)
            {
                _logger.LogInformation("  Kill Switch: Transitioning to Connected...");
                _killSwitch.TransitionToConnected((uint)interfaceIndex);
            }

            // 3b. Enable DNS leak protection (ALWAYS, regardless of kill switch or split tunnel mode)
            // In include mode, svchost.exe is auto-included by SplitTunnelManager so the
            // DNS Client service stays on tunnel. DNS leak protection can safely block
            // DNS on physical — all resolution goes through tunnel DNS.
            _logger.LogInformation("  DNS Leak Protection: Enabling...");

            try
            {
                _killSwitch.EnableDnsLeakProtection((uint)interfaceIndex);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[DNS] Failed to enable DNS leak protection");
                if (_config.IsDevMode)
                {
                    _logger.LogInformation("[DNS] Dev mode detected - continuing without DNS leak protection");
                    // In dev mode, gracefully degrade - don't block the connection
                }
                else
                {
                    // In production, this is critical - re-throw
                    throw;
                }
            }

            // 3c. Enable IPv6 leak protection (conditional - detect if tunnel has IPv6)
            _logger.LogInformation("  IPv6 Leak Protection: Enabling...");
            bool tunnelHasIpv6 = result.AssignedIp?.Contains(':') == true
                || connectParams.Config.Address?.Contains(':') == true;
            try
            {
                bool hasAppSplitTunnel = SplitTunnelEnabled && _splitTunnel.HasAppRules(connectParams.SplitTunneling);
                bool hasIpIncludeMode = SplitTunnelEnabled && _splitTunnel.HasIpRules(connectParams.SplitTunneling)
                    && connectParams.SplitTunneling?.Mode == "include";
                // Skip IPv6 block when split tunneling needs physical IPv6:
                // - App rules: excluded/included apps need physical IPv6 access
                // - Include mode IP rules: general IPv6 traffic should use physical adapter
                _killSwitch.EnableIpv6LeakProtection((uint)interfaceIndex, tunnelHasIpv6,
                    skipBlock: hasAppSplitTunnel || hasIpIncludeMode);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[IPv6] Failed to enable IPv6 leak protection");
                if (_config.IsDevMode)
                {
                    _logger.LogInformation("[IPv6] Dev mode detected - continuing without IPv6 leak protection");
                    // In dev mode, gracefully degrade - don't block the connection
                }
                else
                {
                    // In production, this is critical - re-throw
                    throw;
                }
            }

            // Note: In Option A (exclude mode), the driver handles per-app IPv6 PERMITs and catch-all BLOCK.
            // No blanket physical interface PERMIT needed from the service — it would override the driver's BLOCK
            // due to cross-sublayer CLEAR_ACTION_RIGHT interactions.

            // NOTE: Persistent block filters are NOT added during connection.
            // They live in a separate WFP sublayer, and a BLOCK in any sublayer
            // overrides PERMITs in other sublayers — so persistent block-all would
            // block tunnel traffic even though the dynamic sublayer permits it.
            // Persistent filters are only added on disconnect (DisconnectWithPersistentBlock)
            // when the user wants to stay protected without an active tunnel.

            // PHASE 4: Enable IP-based split tunneling via routing table manipulation
            if (SplitTunnelEnabled && _splitTunnel.HasIpRules(connectParams.SplitTunneling))
            {
                _logger.LogInformation("[SPLIT TUNNEL] Enabling IP-based split tunneling via routing table...");
                try
                {
                    var (physicalIp, _) = GetPhysicalAdapterIp();
                    var tunnelGatewayIp = result.AssignedIp ?? connectParams.Config.Address?.Split('/')[0] ?? "";

                    // Extract tunnel IPv6 address from WireGuard config (e.g., "10.0.0.2/32, fd86:ea04:1115::2/128")
                    string? tunnelGatewayIpV6 = null;
                    if (!string.IsNullOrEmpty(connectParams.Config.Address))
                    {
                        foreach (var part in connectParams.Config.Address.Split(','))
                        {
                            var addr = part.Trim().Split('/')[0];
                            if (addr.Contains(':'))
                            {
                                tunnelGatewayIpV6 = addr;
                                break;
                            }
                        }
                    }

                    if (!string.IsNullOrEmpty(physicalIp) && !string.IsNullOrEmpty(tunnelGatewayIp))
                    {
                        var ipRoutesOk = _splitTunnel.EnableIpSplitTunneling(
                            connectParams.SplitTunneling!, physicalIp, interfaceIndex, tunnelGatewayIp, tunnelGatewayIpV6);

                        if (ipRoutesOk)
                        {
                            _logger.LogInformation("[SPLIT TUNNEL] IP routes configured successfully");

                            // Add kill switch WFP permits for excluded IPs (so they bypass block-all)
                            if (connectParams.KillSwitch && connectParams.SplitTunneling!.Mode == "exclude")
                            {
                                _logger.LogInformation("[SPLIT TUNNEL] Adding kill switch permits for excluded IPs...");
                                _killSwitch.AddSplitTunnelIpPermits(connectParams.SplitTunneling.Ips);
                            }
                        }
                        else
                        {
                            _logger.LogWarning("[SPLIT TUNNEL] Failed to configure IP routes");
                        }
                    }
                    else
                    {
                        _logger.LogWarning("[SPLIT TUNNEL] Could not determine adapter IPs for IP-based routing");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[SPLIT TUNNEL] Failed to enable IP-based split tunneling — continuing without it");
                }
            }

            // PHASE 5: Add physical interface permit for kill switch + split tunnel compatibility
            // Weight 150: above block-all (10), below DNS block (165) so DNS stays tunneled
            if (connectParams.KillSwitch)
            {
                bool hasAppRules = SplitTunnelEnabled && _splitTunnel.HasAppRules(connectParams.SplitTunneling);
                bool isIpIncludeMode = SplitTunnelEnabled && _splitTunnel.HasIpRules(connectParams.SplitTunneling)
                    && connectParams.SplitTunneling?.Mode == "include";

                if (hasAppRules || isIpIncludeMode)
                {
                    var physIfIndex = _splitTunnel.PhysicalInterfaceIndex;
                    if (physIfIndex > 0)
                    {
                        _logger.LogInformation("[SPLIT TUNNEL] Adding physical interface permit for kill switch compatibility (ifIndex={Index})", physIfIndex);
                        _killSwitch.AddPhysicalInterfacePermit((uint)physIfIndex);
                    }
                }
            }

            // Run IPv6 split tunnel diagnostics if split tunneling is active
            if (SplitTunnelEnabled && _splitTunnel.HasAppRules(connectParams.SplitTunneling))
            {
                _ = Task.Run(() => RunIpv6SplitTunnelDiagnostics((uint)interfaceIndex));
            }

            // Flush DNS cache so apps immediately use the VPN's DNS resolver.
            // Without this, Windows DNS Client may have cached negative results
            // from the brief bootstrap period (when IPv6 was blocked), causing
            // 60-90 second delays on first connect.
            _logger.LogInformation("[DNS] Flushing DNS resolver cache...");
            try
            {
                var dnsFlush = new System.Diagnostics.Process();
                dnsFlush.StartInfo.FileName = "ipconfig";
                dnsFlush.StartInfo.Arguments = "/flushdns";
                dnsFlush.StartInfo.UseShellExecute = false;
                dnsFlush.StartInfo.CreateNoWindow = true;
                dnsFlush.Start();
                dnsFlush.WaitForExit(5000);
                _logger.LogInformation("[DNS] DNS cache flushed");
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[DNS] Failed to flush DNS cache (non-fatal)");
            }

            _connectionState.SetConnected(result.AssignedIp, connectParams.ServerId);

            // Store params for potential auto-reconnect on connection drop
            _lastConnectParams = connectParams;

            // Persist to disk for auto-reconnect on boot (only when always-on KS is enabled)
            if (_killSwitch.IsAdvancedModeEnabled)
            {
                var autoReconnectConfig = AutoReconnectConfig.FromConnectParams(connectParams);
                autoReconnectConfig.Save();
                _logger.LogInformation("[AutoReconnect] Connection config saved to disk for boot reconnect");
            }

            _logger.LogInformation("****************************************");
            _logger.LogInformation("*  VPN CONNECTION SUCCESSFUL!          *");
            _logger.LogInformation("****************************************");

            return new ConnectResult
            {
                SessionId = Guid.NewGuid().ToString(),
                AssignedIp = result.AssignedIp,
                ServerIp = _currentServerIp ?? ""
            };
        }
        catch (Exception ex)
        {
            _connectionState.SetError(ex.Message);

            // Cleanup on failure
            try { _splitTunnel.DisableAppSplitTunneling(); } catch { /* best effort */ }
            try { _splitTunnel.DisableIpSplitTunneling(); } catch { /* best effort */ }
            try { _killSwitch.RemoveSplitTunnelIpPermits(); } catch { /* best effort */ }
            try { _killSwitch.RemovePhysicalInterfacePermit(); } catch { /* best effort */ }
            _killSwitch.DisableDnsLeakProtection();
            _killSwitch.DisableIpv6LeakProtection();
            _killSwitch.Disable();
            await _wireGuard.DisconnectAsync(cancellationToken);

            throw new JsonRpcException(JsonRpcErrorCodes.ConnectionFailed, ex.Message);
        }
    }

    private async Task<object> HandleDisconnectAsync(JsonRpcRequest request, CancellationToken cancellationToken)
    {
        // Parse optional disableProtection param
        bool disableProtection = true; // default: full disconnect
        try
        {
            var paramsJson = JsonSerializer.Serialize(request.Params);
            var disconnectParams = JsonSerializer.Deserialize<DisconnectParams>(paramsJson);
            if (disconnectParams != null)
                disableProtection = disconnectParams.DisableProtection;
        }
        catch { /* use default */ }

        if (_connectionState.Current.Status == ConnectionStatus.Disconnected
            && _killSwitch.State != KillSwitchStateEnum.PersistentBlock)
        {
            _logger.LogInformation("Disconnect requested but already disconnected");
            return new { success = true };
        }

        // Handle PersistentBlock → disable advanced KS (user wants full disconnect)
        if (_killSwitch.State == KillSwitchStateEnum.PersistentBlock)
        {
            _logger.LogInformation("[AdvKS] Disconnect from PersistentBlock — disabling persistent filters");
            _killSwitch.DisablePersistentBlock();
            _connectionState.SetDisconnected();
            return new { success = true };
        }

        _logger.LogInformation("****************************************");
        _logger.LogInformation("*  VPN DISCONNECTION SEQUENCE          *");
        _logger.LogInformation("****************************************");
        _logger.LogInformation("  Kill Switch State: {State}", _killSwitch.State);
        _logger.LogInformation("  Advanced KS Active: {Active}", _killSwitch.IsAdvancedModeActive);
        _logger.LogInformation("  Disable Protection: {Disable}", disableProtection);

        _connectionState.SetDisconnecting();

        bool killSwitchDisabled = false;
        bool wireGuardDisconnected = false;
        Exception? lastException = null;

        // Step 1: Disable protections (with independent error handling)
        try
        {
            _logger.LogInformation("----------------------------------------");
            _logger.LogInformation("[STEP 1/3] Disabling VPN Protections...");

            // 1a. Disable split tunneling (before tearing down tunnel)
            _logger.LogInformation("  Split Tunnel: Cleaning up...");
            try { _splitTunnel.DisableAppSplitTunneling(); }
            catch (Exception ex) { _logger.LogWarning(ex, "[SPLIT TUNNEL] App cleanup error"); }
            try { _splitTunnel.DisableIpSplitTunneling(); }
            catch (Exception ex) { _logger.LogWarning(ex, "[SPLIT TUNNEL] IP route cleanup error"); }
            try { _killSwitch.RemoveSplitTunnelIpPermits(); }
            catch (Exception ex) { _logger.LogWarning(ex, "[SPLIT TUNNEL] IP permit cleanup error"); }
            try { _killSwitch.RemovePhysicalInterfacePermit(); }
            catch (Exception ex) { _logger.LogWarning(ex, "[SPLIT TUNNEL] Physical permit cleanup error"); }

            // 1b. Disable DNS leak protection
            _logger.LogInformation("  DNS Leak Protection: Disabling...");
            _killSwitch.DisableDnsLeakProtection();

            // 1b. Disable IPv6 leak protection (separate from DNS)
            _logger.LogInformation("  IPv6 Leak Protection: Disabling...");
            _killSwitch.DisableIpv6LeakProtection();

            // 1c. Handle kill switch based on advanced mode
            if (_killSwitch.IsAdvancedModeEnabled && !disableProtection)
            {
                // Advanced mode: create persistent block-all filters to protect while disconnected
                _logger.LogInformation("  Kill Switch: Disconnecting with persistent protection...");
                _killSwitch.DisconnectWithPersistentBlock();
            }
            else
            {
                // Standard mode or user wants to fully disable
                _logger.LogInformation("  Kill Switch: Disabling...");
                _killSwitch.Disable();
            }

            killSwitchDisabled = true;
            _logger.LogInformation("[STEP 1/3] VPN protections disabled successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[STEP 1/3] Error disabling protections - continuing with WireGuard disconnect");
            lastException = ex;
            // Continue to WireGuard disconnect even if protection disable fails
        }

        // Step 2: Disconnect WireGuard (ALWAYS attempt, even if step 1 failed)
        try
        {
            _logger.LogInformation("----------------------------------------");
            _logger.LogInformation("[STEP 2/3] Disconnecting WireGuard Tunnel...");
            await _wireGuard.DisconnectAsync(cancellationToken);
            wireGuardDisconnected = true;
            _logger.LogInformation("[STEP 2/3] WireGuard disconnected successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[STEP 2/3] Error disconnecting WireGuard");
            lastException = ex;
        }

        // Step 3: Remove server-specific firewall rule
        try
        {
            _logger.LogInformation("----------------------------------------");
            _logger.LogInformation("[STEP 3/3] Removing server firewall rule...");
            if (_currentServerIp != null)
            {
                _firewallManager.RemoveServerRule(_currentServerIp);
                _currentServerIp = null;
            }

            // Cancel any pending auto-reconnect (user-initiated disconnect)
            _reconnectCts?.Cancel();
            _reconnectCts = null;
            _lastConnectParams = null;

            // Clear persisted config on full disconnect (not when transitioning to PersistentBlock)
            if (disableProtection)
            {
                AutoReconnectConfig.Delete();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[STEP 3/3] Error removing server firewall rule (non-fatal)");
        }

        // Always set to disconnected state
        _connectionState.SetDisconnected();

        // Report results
        if (killSwitchDisabled && wireGuardDisconnected)
        {
            _logger.LogInformation("****************************************");
            _logger.LogInformation("*  VPN DISCONNECTED SUCCESSFULLY       *");
            _logger.LogInformation("****************************************");
            return new { success = true };
        }
        else
        {
            _logger.LogWarning("****************************************");
            _logger.LogWarning("*  VPN DISCONNECTED WITH ERRORS        *");
            _logger.LogWarning("****************************************");
            _logger.LogWarning("Kill Switch Disabled: {KS}, WireGuard Disconnected: {WG}",
                killSwitchDisabled, wireGuardDisconnected);

            if (lastException != null)
            {
                throw new JsonRpcException(
                    JsonRpcErrorCodes.InternalError,
                    $"Disconnect partially failed: {lastException.Message}",
                    new { killSwitchDisabled, wireGuardDisconnected });
            }

            return new { success = true, warning = "Disconnect completed with errors" };
        }
    }

    private StatusResult HandleGetStatus()
    {
        var state = _connectionState.Current;
        return new StatusResult
        {
            State = state.Status.ToString().ToLowerInvariant(),
            KillSwitchActive = _killSwitch.IsEnabled,
            KillSwitchState = _killSwitch.State.ToString().ToLowerInvariant(),
            AssignedIp = state.AssignedIp,
            ConnectedSince = state.ConnectedAt?.ToString("O"),
            Server = state.ServerId != null ? new ServerInfo { Id = state.ServerId } : null,
            AdvancedKillSwitchEnabled = _killSwitch.IsAdvancedModeEnabled,
            AdvancedKillSwitchActive = _killSwitch.IsAdvancedModeActive
        };
    }

    private async Task<StatsResult> HandleGetStatsAsync(CancellationToken cancellationToken)
    {
        var stats = await _wireGuard.GetStatsAsync(cancellationToken);
        return new StatsResult
        {
            BytesIn = stats.BytesReceived,
            BytesOut = stats.BytesSent
        };
    }

    private object HandleEnableKillSwitch(JsonRpcRequest request)
    {
        var paramsJson = JsonSerializer.Serialize(request.Params);
        using var doc = JsonDocument.Parse(paramsJson);
        var serverIp = doc.RootElement.GetProperty("serverIp").GetString()
            ?? throw new JsonRpcException(JsonRpcErrorCodes.InvalidParams, "serverIp is required");

        var interfaceIndex = 0;
        if (doc.RootElement.TryGetProperty("interfaceIndex", out var ifIndexElem))
        {
            interfaceIndex = ifIndexElem.GetInt32();
        }

        _killSwitch.Enable(serverIp, interfaceIndex);
        return new { success = true };
    }

    private object HandleDisableKillSwitch()
    {
        _killSwitch.Disable();
        return new { success = true };
    }

    private object HandleEnableAdvancedKillSwitch()
    {
        _killSwitch.SetAdvancedModeEnabled(true);
        // If already connected, persist config now so boot reconnect works
        if (_lastConnectParams != null)
        {
            var autoReconnectConfig = AutoReconnectConfig.FromConnectParams(_lastConnectParams);
            autoReconnectConfig.Save();
            _logger.LogInformation("[AutoReconnect] Connection config saved (advanced KS enabled while connected)");
        }
        return new { success = true, advancedKillSwitchEnabled = true };
    }

    private object HandleDisableAdvancedKillSwitch()
    {
        _killSwitch.SetAdvancedModeEnabled(false);
        // If currently in persistent block, disable it
        if (_killSwitch.IsAdvancedModeActive)
        {
            _killSwitch.DisablePersistentBlock();
            _connectionState.SetDisconnected();
        }
        // Clear persisted connection config (no longer needed without always-on KS)
        AutoReconnectConfig.Delete();
        return new { success = true, advancedKillSwitchEnabled = false };
    }

    private async Task<object> HandleEmergencyResetAsync(CancellationToken cancellationToken)
    {
        _logger.LogWarning("[EMERGENCY] Emergency reset requested via IPC");

        // Cancel any pending reconnect
        _reconnectCts?.Cancel();

        // Disconnect WireGuard if running
        try { await _wireGuard.DisconnectAsync(cancellationToken); }
        catch (Exception ex) { _logger.LogError(ex, "[EMERGENCY] WireGuard disconnect failed"); }

        // Clean up split tunneling
        try { _splitTunnel.DisableAppSplitTunneling(); }
        catch (Exception ex) { _logger.LogError(ex, "[EMERGENCY] App split tunnel disable failed"); }
        try { _splitTunnel.DisableIpSplitTunneling(); }
        catch (Exception ex) { _logger.LogError(ex, "[EMERGENCY] IP split tunnel disable failed"); }

        // Nuke all WFP filters
        _killSwitch.EmergencyReset();

        // Reset connection state
        _connectionState.SetDisconnected();
        _lastConnectParams = null;
        AutoReconnectConfig.Delete();

        return new { success = true };
    }

    private static readonly int[] AutoReconnectDelaysMs =
        { 2000, 4000, 8000, 16000, 32000, 60000, 120000, 300000, 300000, 300000 };

    private async Task AutoReconnectAsync(ConnectParams connectParams, CancellationToken cancellationToken)
    {
        int maxAttempts = AutoReconnectDelaysMs.Length;

        for (int attempt = 1; attempt <= maxAttempts; attempt++)
        {
            if (cancellationToken.IsCancellationRequested) return;

            int delayMs = AutoReconnectDelaysMs[attempt - 1];
            _logger.LogInformation("[AutoReconnect] Waiting {Delay}s before attempt {Attempt}/{Total}...",
                delayMs / 1000, attempt, maxAttempts);
            try { await Task.Delay(delayMs, cancellationToken); }
            catch (OperationCanceledException) { return; }

            if (cancellationToken.IsCancellationRequested) return;

            // Only attempt if still in an error/bootstrap state (not user-disconnected)
            if (_connectionState.Current.Status == ConnectionStatus.Connected) return;

            _logger.LogInformation("[AutoReconnect] Attempt {Attempt}/{Total}: reconnecting...", attempt, maxAttempts);
            try
            {
                // Re-run the connect using the stored params (HandleConnectAsync calls SetConnecting internally)
                var fakeRequest = new JsonRpcRequest { Method = "connect", Params = connectParams };
                await HandleConnectAsync(fakeRequest, cancellationToken);
                _logger.LogInformation("[AutoReconnect] Reconnect successful on attempt {Attempt}", attempt);
                return;
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[AutoReconnect] Attempt {Attempt} failed", attempt);
                // HandleConnectAsync's catch already called Disable() — next attempt will re-enable bootstrap
            }
        }

        _logger.LogWarning("[AutoReconnect] All {Count} attempts exhausted — giving up", maxAttempts);

        // Give-up behavior depends on kill switch type:
        // Always-on KS → transition to PersistentBlock (protected, user must manually reconnect)
        // Standard KS  → full cleanup (restore internet, user is unprotected)
        if (_killSwitch.IsAdvancedModeEnabled)
        {
            _logger.LogInformation("[AutoReconnect] Always-on KS enabled — activating PersistentBlock");
            _killSwitch.EnablePersistentBlock();
            _connectionState.SetError("Auto-reconnect failed — internet blocked for protection. Click connect to retry.");
        }
        else
        {
            _logger.LogInformation("[AutoReconnect] Standard KS — cleaning up to restore internet");
            try { _splitTunnel.DisableAppSplitTunneling(); } catch { }
            try { _splitTunnel.DisableIpSplitTunneling(); } catch { }
            _killSwitch.DisableDnsLeakProtection();
            _killSwitch.DisableIpv6LeakProtection();
            _killSwitch.Disable();
            await _wireGuard.DisconnectAsync(CancellationToken.None);
            if (_currentServerIp != null)
            {
                try { _firewallManager.RemoveServerRule(_currentServerIp); } catch { }
                _currentServerIp = null;
            }
            _lastConnectParams = null;
            _connectionState.SetDisconnected();
        }
    }

    private object HandleGetDnsFilterStats()
    {
        _killSwitch.DumpDnsFilterStats();
        return new { success = true, message = "DNS filter statistics dumped to service logs" };
    }

    private object HandleGetDiagnostics()
    {
        return _killSwitch.GetDiagnostics();
    }

    private static string Serialize(object obj) => JsonSerializer.Serialize(obj);

    /// <summary>
    /// Replace /0 AllowedIPs with /1 pairs to prevent WireGuard tunnel.dll from
    /// enabling its built-in WFP "block all" firewall. WG checks specifically for
    /// AllowedIPs with Bits()==0 to trigger blocking. Using /1 pairs gives identical
    /// routing coverage (0.0.0.0/1 + 128.0.0.0/1 = all IPv4) without the block.
    /// </summary>
    private string RewriteAllowedIPsForSplitTunnel(string allowedIPs, bool stripIpv6)
    {
        if (string.IsNullOrEmpty(allowedIPs))
            return allowedIPs;

        var parts = allowedIPs.Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Trim()).ToList();

        var result = new List<string>();
        foreach (var part in parts)
        {
            if (part == "0.0.0.0/0")
            {
                result.Add("0.0.0.0/1");
                result.Add("128.0.0.0/1");
            }
            else if (part == "::/0")
            {
                if (stripIpv6)
                {
                    _logger.LogInformation("[SPLIT TUNNEL] Stripping ::/0 from AllowedIPs — excluded apps use physical IPv6, non-excluded IPv6 blocked by driver");
                }
                else
                {
                    result.Add("::/1");
                    result.Add("8000::/1");
                }
            }
            else if (stripIpv6 && part.Contains(':'))
            {
                _logger.LogInformation("[SPLIT TUNNEL] Stripping IPv6 entry '{Entry}' from AllowedIPs", part);
            }
            else
            {
                result.Add(part);
            }
        }

        var rewritten = string.Join(", ", result);
        _logger.LogInformation("[AWG] AllowedIPs rewritten (/0 → /1 pairs): '{Old}' -> '{New}'",
            allowedIPs, rewritten);
        return rewritten;
    }

    /// <summary>
    /// Exhaustive IPv6 split tunnel diagnostics — runs after all WFP filters and routes are set up.
    /// </summary>
    private void RunIpv6SplitTunnelDiagnostics(uint tunnelIfIndex)
    {
        try
        {
            _logger.LogInformation("=== [DIAG] IPv6 SPLIT TUNNEL DIAGNOSTICS START ===");

            var physIfIndex = _splitTunnel.PhysicalInterfaceIndex;
            _logger.LogInformation("[DIAG] Tunnel interface index: {TunnelIf}, Physical interface index: {PhysIf}",
                tunnelIfIndex, physIfIndex);

            // 1. Kill switch state and IPv6 leak protection state
            _logger.LogInformation("[DIAG] Kill switch state: {State}, DNS leak active: {Dns}, IPv6 leak active: {Ipv6}",
                _killSwitch.State, _killSwitch.IsDnsLeakProtectionActive, _killSwitch.IsIpv6LeakProtectionActive);

            // 2. Dump all IPv6 filter info from kill switch
            _killSwitch.DumpIpv6FilterInfo();

            // 3. Check IPv6 routes
            _logger.LogInformation("[DIAG] Checking IPv6 routes...");
            var routeOutput = RunCommandCapture("netsh", "interface ipv6 show route");
            foreach (var line in routeOutput.Split('\n'))
            {
                var trimmed = line.Trim();
                if (trimmed.Contains("::/1") || trimmed.Contains("8000::/1") || trimmed.Contains("::/0"))
                    _logger.LogInformation("[DIAG] Route: {Line}", trimmed);
            }

            // 4. Check driver state (HasV6, counters)
            _logger.LogInformation("[DIAG] Querying driver state...");
            _splitTunnel.DumpDriverState();

            // 5. Check WFP filters from ALL providers on IPv6 outbound transport layer
            _logger.LogInformation("[DIAG] Dumping WFP filters to temp file...");
            var wfpFile = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "wiredog-wfp-filters.xml");
            RunCommandCapture("netsh", $"wfp show filters file={wfpFile}");
            _logger.LogInformation("[DIAG] WFP filters dumped to: {Path}", wfpFile);

            // Parse WFP XML for IPv6-related blocks
            try
            {
                if (System.IO.File.Exists(wfpFile))
                {
                    var xml = System.IO.File.ReadAllText(wfpFile);

                    // Count IPv6 transport layer filters
                    var v6TransportCount = CountSubstring(xml, "FWPM_LAYER_OUTBOUND_TRANSPORT_V6");
                    var v6IpPacketCount = CountSubstring(xml, "FWPM_LAYER_OUTBOUND_IPPACKET_V6");
                    var v6InTransportCount = CountSubstring(xml, "FWPM_LAYER_INBOUND_TRANSPORT_V6");
                    var v6InIpPacketCount = CountSubstring(xml, "FWPM_LAYER_INBOUND_IPPACKET_V6");
                    var v6AuthConnectCount = CountSubstring(xml, "FWPM_LAYER_ALE_AUTH_CONNECT_V6");
                    var v6AuthRecvCount = CountSubstring(xml, "FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6");
                    var blockCount = CountSubstring(xml, "FWP_ACTION_BLOCK");

                    _logger.LogInformation("[DIAG] WFP IPv6 filter counts:");
                    _logger.LogInformation("[DIAG]   OUTBOUND_TRANSPORT_V6: {Count}", v6TransportCount);
                    _logger.LogInformation("[DIAG]   OUTBOUND_IPPACKET_V6: {Count}", v6IpPacketCount);
                    _logger.LogInformation("[DIAG]   INBOUND_TRANSPORT_V6: {Count}", v6InTransportCount);
                    _logger.LogInformation("[DIAG]   INBOUND_IPPACKET_V6: {Count}", v6InIpPacketCount);
                    _logger.LogInformation("[DIAG]   ALE_AUTH_CONNECT_V6: {Count}", v6AuthConnectCount);
                    _logger.LogInformation("[DIAG]   ALE_AUTH_RECV_ACCEPT_V6: {Count}", v6AuthRecvCount);
                    _logger.LogInformation("[DIAG]   Total FWP_ACTION_BLOCK filters: {Count}", blockCount);

                    // Extract block filters that mention IPv6 layers
                    ExtractIpv6BlockFilters(xml);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[DIAG] Failed to parse WFP filter dump");
            }

            // 6. Test IPv6 connectivity from SERVICE process (not split-tunneled)
            _logger.LogInformation("[DIAG] Testing IPv6 connectivity from service process...");
            try
            {
                using var tcpClient = new System.Net.Sockets.TcpClient(System.Net.Sockets.AddressFamily.InterNetworkV6);
                tcpClient.SendTimeout = 5000;
                tcpClient.ReceiveTimeout = 5000;
                var connectTask = tcpClient.ConnectAsync(
                    System.Net.IPAddress.Parse("2606:4700:4700::1111"), 80);
                if (connectTask.Wait(5000))
                {
                    _logger.LogInformation("[DIAG] Service IPv6 connectivity: SUCCESS (connected to 2606:4700:4700::1111:80)");
                    tcpClient.Close();
                }
                else
                {
                    _logger.LogWarning("[DIAG] Service IPv6 connectivity: TIMEOUT (could not connect to 2606:4700:4700::1111:80)");
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("[DIAG] Service IPv6 connectivity: FAILED ({Error})", ex.Message);
            }

            // 7. Test IPv6 connectivity bound to PHYSICAL address (simulates split-tunneled app)
            _logger.LogInformation("[DIAG] Testing IPv6 connectivity bound to physical adapter...");
            var (_, physV6) = GetPhysicalAdapterIp();
            if (physV6 != null)
            {
                try
                {
                    using var socket = new System.Net.Sockets.Socket(
                        System.Net.Sockets.AddressFamily.InterNetworkV6,
                        System.Net.Sockets.SocketType.Stream,
                        System.Net.Sockets.ProtocolType.Tcp);
                    socket.SendTimeout = 5000;
                    socket.ReceiveTimeout = 5000;

                    // Bind to physical IPv6 (same as what the driver does)
                    var localEp = new System.Net.IPEndPoint(System.Net.IPAddress.Parse(physV6), 0);
                    socket.Bind(localEp);
                    _logger.LogInformation("[DIAG] Bound socket to physical IPv6: {Addr}", physV6);

                    var connectTask = socket.ConnectAsync(
                        new System.Net.IPEndPoint(
                            System.Net.IPAddress.Parse("2606:4700:4700::1111"), 80));
                    if (connectTask.Wait(5000))
                    {
                        _logger.LogInformation("[DIAG] Physical IPv6 connectivity: SUCCESS");
                        socket.Close();
                    }
                    else
                    {
                        _logger.LogWarning("[DIAG] Physical IPv6 connectivity: TIMEOUT — WFP or routing is blocking physical IPv6");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("[DIAG] Physical IPv6 connectivity: FAILED ({Error})", ex.Message);
                }
            }
            else
            {
                _logger.LogWarning("[DIAG] No physical IPv6 address found — cannot test physical IPv6 connectivity");
            }

            _logger.LogInformation("=== [DIAG] IPv6 SPLIT TUNNEL DIAGNOSTICS END ===");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[DIAG] IPv6 diagnostics failed");
        }
    }

    private static string RunCommandCapture(string cmd, string args)
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo(cmd, args)
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using var proc = System.Diagnostics.Process.Start(psi);
            if (proc != null)
            {
                var output = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(10000);
                return output;
            }
        }
        catch { }
        return "";
    }

    private static int CountSubstring(string text, string substr)
    {
        int count = 0, index = 0;
        while ((index = text.IndexOf(substr, index, StringComparison.OrdinalIgnoreCase)) != -1)
        {
            count++;
            index += substr.Length;
        }
        return count;
    }

    private void ExtractIpv6BlockFilters(string xml)
    {
        // Find sections that contain both BLOCK and an IPv6 layer
        var ipv6Layers = new[] {
            "FWPM_LAYER_OUTBOUND_TRANSPORT_V6",
            "FWPM_LAYER_OUTBOUND_IPPACKET_V6",
            "FWPM_LAYER_INBOUND_TRANSPORT_V6",
            "FWPM_LAYER_INBOUND_IPPACKET_V6",
            "FWPM_LAYER_ALE_AUTH_CONNECT_V6",
            "FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6",
            "FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6",
            "FWPM_LAYER_ALE_BIND_REDIRECT_V6"
        };

        // Split by <item> tags to get individual filters
        var items = xml.Split(new[] { "<item>" }, StringSplitOptions.RemoveEmptyEntries);
        int blockFilterCount = 0;

        foreach (var item in items)
        {
            if (!item.Contains("FWP_ACTION_BLOCK", StringComparison.OrdinalIgnoreCase))
                continue;

            bool isIpv6 = false;
            string matchedLayer = "";
            foreach (var layer in ipv6Layers)
            {
                if (item.Contains(layer, StringComparison.OrdinalIgnoreCase))
                {
                    isIpv6 = true;
                    matchedLayer = layer;
                    break;
                }
            }

            if (!isIpv6) continue;

            blockFilterCount++;

            // Extract filter name
            var nameStart = item.IndexOf("<displayData>");
            var nameEnd = item.IndexOf("</displayData>");
            string filterName = "unknown";
            if (nameStart >= 0 && nameEnd > nameStart)
            {
                var displayData = item.Substring(nameStart, nameEnd - nameStart);
                var nameTagStart = displayData.IndexOf("<name>");
                var nameTagEnd = displayData.IndexOf("</name>");
                if (nameTagStart >= 0 && nameTagEnd > nameTagStart)
                    filterName = displayData.Substring(nameTagStart + 6, nameTagEnd - nameTagStart - 6);
            }

            // Extract weight
            string weight = "unknown";
            var weightStart = item.IndexOf("<weight>");
            if (weightStart >= 0)
            {
                var weightSection = item.Substring(weightStart, Math.Min(200, item.Length - weightStart));
                var valStart = weightSection.IndexOf("<uint64>");
                var valEnd = weightSection.IndexOf("</uint64>");
                if (valStart >= 0 && valEnd > valStart)
                    weight = weightSection.Substring(valStart + 8, valEnd - valStart - 8);
                else
                {
                    valStart = weightSection.IndexOf("<uint8>");
                    valEnd = weightSection.IndexOf("</uint8>");
                    if (valStart >= 0 && valEnd > valStart)
                        weight = weightSection.Substring(valStart + 7, valEnd - valStart - 7);
                }
            }

            _logger.LogWarning("[DIAG] IPv6 BLOCK filter found: name='{Name}', layer={Layer}, weight={Weight}",
                filterName, matchedLayer, weight);
        }

        _logger.LogInformation("[DIAG] Total IPv6 BLOCK filters found: {Count}", blockFilterCount);
    }

    /// <summary>
    /// Get the IP address of the physical (non-tunnel) network adapter.
    /// This is the adapter with the default gateway.
    /// </summary>
    private (string? ipv4, string? ipv6) GetPhysicalAdapterIp()
    {
        try
        {
            var interfaces = System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces();
            foreach (var iface in interfaces)
            {
                if (iface.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up)
                    continue;
                if (iface.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Loopback)
                    continue;
                // Skip WireGuard tunnel interfaces
                if (iface.Name.Contains("WireGuard", StringComparison.OrdinalIgnoreCase) ||
                    iface.Name.Contains("wg", StringComparison.OrdinalIgnoreCase) ||
                    iface.Description.Contains("WireGuard", StringComparison.OrdinalIgnoreCase))
                    continue;

                var props = iface.GetIPProperties();
                // Must have a default gateway
                if (props.GatewayAddresses.Count == 0)
                    continue;

                string? v4 = null;
                string? v6 = null;
                foreach (var addr in props.UnicastAddresses)
                {
                    if (addr.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                        v4 = addr.Address.ToString();
                    else if (addr.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6
                             && !addr.Address.IsIPv6LinkLocal)
                    {
                        // Use global unicast IPv6 for split tunnel redirect.
                        // Prefer primary SLAAC address over temporary/privacy address.
                        if (v6 == null || addr.SuffixOrigin != System.Net.NetworkInformation.SuffixOrigin.Random)
                            v6 = addr.Address.ToString();
                    }
                }

                if (v4 != null)
                {
                    _logger.LogInformation("[SPLIT TUNNEL] Physical adapter: {Name} (v4={Ip4}, v6={Ip6})",
                        iface.Name, v4, v6 ?? "none");
                    return (v4, v6);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[SPLIT TUNNEL] Failed to enumerate network adapters");
        }
        return (null, null);
    }
}

/// <summary>
/// Exception for JSON-RPC errors
/// </summary>
public class JsonRpcException : Exception
{
    public int Code { get; }
    public new object? Data { get; }

    public JsonRpcException(int code, string message, object? data = null)
        : base(message)
    {
        Code = code;
        Data = data;
    }
}
