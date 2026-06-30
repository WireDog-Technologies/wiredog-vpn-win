using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Serilog;
using WireDog.Service;
using WireDog.Service.Firewall;
using WireDog.Service.Ipc;
using WireDog.Service.KillSwitch;
using WireDog.Service.Tunnel;
using WireDog.Service.SplitTunnel;
using WireDog.Service.Wfp;

// Handle /tunnel mode (called by AmneziaWGTunnel$WireDog child service)
if (args.Length >= 2 && args[0] == "/tunnel")
{
    var configPath = args[1];
    return TunnelServiceRunner.Run(configPath);
}

// Handle --cleanup mode (called by uninstaller to remove persistent WFP filters)
if (args.Contains("--cleanup"))
{
    using var loggerFactory = LoggerFactory.Create(b => b.AddConsole());
    var cleanupLogger = loggerFactory.CreateLogger<WfpEngine>();
    using var wfp = new WfpEngine(cleanupLogger);
    try
    {
        wfp.Open();
        wfp.RemovePersistentBlockAllFilters();
        Console.WriteLine("WireDog: Persistent WFP filters removed.");
        WireDog.Service.KillSwitch.AdvancedKillSwitchConfig.Delete();
        WireDog.Service.KillSwitch.AutoReconnectConfig.Delete();
        Console.WriteLine("WireDog: Advanced kill switch config deleted.");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"WireDog cleanup warning: {ex.Message}");
    }
    return 0;
}

// Parse command line args
bool isConsoleMode = args.Contains("--console");
bool isDevMode = args.Contains("--dev");
bool isLocalMode = args.Contains("--local");

// Configure Serilog
var logPath = isDevMode
    ? Path.Combine(Directory.GetCurrentDirectory(), "logs", "service.log")
    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "WireDog", "logs", "service.log");

Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);

var logConfig = new LoggerConfiguration()
    .MinimumLevel.Debug()
    .WriteTo.File(logPath,
        rollingInterval: RollingInterval.Day,
        retainedFileCountLimit: 7,
        outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff} [{Level:u3}] {Message:lj}{NewLine}{Exception}");

if (isConsoleMode)
{
    logConfig.WriteTo.Console(outputTemplate: "{Timestamp:HH:mm:ss} [{Level:u3}] {Message:lj}{NewLine}{Exception}");
}

Log.Logger = logConfig.CreateLogger();

try
{
    Log.Information("WireDog Service starting (Console: {ConsoleMode}, Dev: {DevMode}, Local: {LocalMode}, Version: 2.0)", isConsoleMode, isDevMode, isLocalMode);
    Log.Information("Service executable path: {Path}", System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName);
    Log.Information("Current directory: {Path}", Directory.GetCurrentDirectory());
    Log.Information("AppContext.BaseDirectory: {Path}", AppContext.BaseDirectory);

    var hostBuilder = Host.CreateDefaultBuilder(args);

    if (!isConsoleMode)
    {
        // Configure to run as Windows Service
        hostBuilder.UseWindowsService();
    }

    var host = hostBuilder
        .ConfigureServices(services =>
        {
            Log.Information("Configuring dependency injection services");

            // Register services
            services.AddSingleton<ServiceConfiguration>(sp => new ServiceConfiguration
            {
                IsDevMode = isDevMode,
                IsLocalMode = isLocalMode,
                PipeName = isDevMode ? "WireDog-dev" : "WireDog"
            });

            services.AddSingleton<WfpEngine>();
            services.AddSingleton<KillSwitchManager>();
            services.AddSingleton<WireGuardManager>(sp =>
                {
                    Log.Information("Initializing WireGuardManager");
                    return new WireGuardManager(
                        sp.GetRequiredService<ILogger<WireGuardManager>>(),
                        sp.GetRequiredService<ILoggerFactory>());
                });
            services.AddSingleton<ConnectionStateManager>();
            services.AddSingleton<NetshFirewallManager>();
            services.AddSingleton<DriverClient>();
            services.AddSingleton<RouteManager>();
            services.AddSingleton<SplitTunnelManager>();
            services.AddSingleton<NamedPipeServer>();
            services.AddSingleton<JsonRpcHandler>();

            services.AddHostedService<Worker>();

            services.AddSerilog();
        })
        .Build();

    Log.Information("Dependency injection configured, starting host");

    // Run the host
    await host.RunAsync();
    return 0;
}
catch (Exception ex)
{
    Log.Fatal(ex, "WireDog Service terminated unexpectedly");
    return 1;
}
finally
{
    Log.CloseAndFlush();
}

/// <summary>
/// Service configuration
/// </summary>
public class ServiceConfiguration
{
    public bool IsDevMode { get; set; }
    public bool IsLocalMode { get; set; }
    public string PipeName { get; set; } = "WireDog";
}
