using System.Security.Principal;
using WireDog.Service.Firewall;
using WireDog.Service.Ipc;
using WireDog.Service.KillSwitch;
using WireDog.Service.Wfp;
using KillSwitchStateEnum = WireDog.Service.KillSwitch.KillSwitchState;

namespace WireDog.Service;

/// <summary>
/// Main background worker service that orchestrates all components
/// </summary>
public class Worker : BackgroundService
{
    private readonly ILogger<Worker> _logger;
    private readonly NamedPipeServer _pipeServer;
    private readonly WfpEngine _wfpEngine;
    private readonly KillSwitchManager _killSwitch;
    private readonly NetshFirewallManager _firewallManager;
    private readonly ServiceConfiguration _config;
    private readonly JsonRpcHandler _rpcHandler;

    public Worker(
        ILogger<Worker> logger,
        NamedPipeServer pipeServer,
        WfpEngine wfpEngine,
        KillSwitchManager killSwitch,
        NetshFirewallManager firewallManager,
        ServiceConfiguration config,
        JsonRpcHandler rpcHandler)
    {
        _logger = logger;
        _pipeServer = pipeServer;
        _wfpEngine = wfpEngine;
        _killSwitch = killSwitch;
        _firewallManager = firewallManager;
        _config = config;
        _rpcHandler = rpcHandler;
    }

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("WireDog VPN Service starting...");

        // Check admin privileges
        var isAdmin = IsRunningAsAdmin();
        _logger.LogInformation("Running as Administrator: {IsAdmin}", isAdmin);
        if (!isAdmin)
        {
            _logger.LogWarning("WARNING: Service is NOT running with administrator privileges. WFP operations will fail.");
        }

        try
        {
            // Verify persistent firewall rules exist (self-healing)
            _firewallManager.EnsureRulesExist();

            // Initialize WFP engine with dynamic session (auto-cleanup on crash)
            _wfpEngine.Open();
            _logger.LogInformation("WFP engine initialized with dynamic session");

            // Recover advanced kill switch state from previous session (if active)
            _killSwitch.InitializeFromConfig();

            // If always-on KS was recovered, attempt auto-reconnect (runs in background)
            _rpcHandler.TryAutoReconnectOnStartup();

            // Start Named Pipe server
            await _pipeServer.StartAsync(cancellationToken);
            _logger.LogInformation("Named Pipe server started on \\\\.\\pipe\\{PipeName}", _config.PipeName);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to start service components");
            throw;
        }

        await base.StartAsync(cancellationToken);
    }

    /// <summary>
    /// Check if the service is running with administrator privileges
    /// </summary>
    private bool IsRunningAsAdmin()
    {
        try
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                var principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        }
        catch
        {
            return false;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("WireDog VPN Service is running");

        // Main service loop - just keep alive and handle IPC
        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(1000, stoppingToken);
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("WireDog VPN Service stopping...");

        try
        {
            // Clean up dynamic server firewall rules
            _firewallManager.RemoveAllServerRules();

            // Handle kill switch cleanup on service stop
            if (_killSwitch.State == KillSwitchStateEnum.Connected || _killSwitch.State == KillSwitchStateEnum.Bootstrap)
            {
                // If advanced mode is enabled, create persistent block to protect user while service is stopped
                if (_killSwitch.IsAdvancedModeEnabled)
                {
                    _killSwitch.DisconnectWithPersistentBlock();
                    _logger.LogInformation("Advanced kill switch: created PersistentBlock (persistent filters protect during service stop)");
                }
                else
                {
                    _killSwitch.Disable();
                    _logger.LogInformation("Kill switch disabled");
                }
            }

            // Stop pipe server
            await _pipeServer.StopAsync(cancellationToken);
            _logger.LogInformation("Named Pipe server stopped");

            // Close WFP engine (this auto-removes all dynamic filters)
            _wfpEngine.Close();
            _logger.LogInformation("WFP engine closed - all dynamic filters removed");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during service shutdown");
        }

        await base.StopAsync(cancellationToken);
        _logger.LogInformation("WireDog VPN Service stopped");
    }
}
