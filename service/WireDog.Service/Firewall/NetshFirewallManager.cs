using System.Diagnostics;

namespace WireDog.Service.Firewall;

/// <summary>
/// Manages persistent Windows Firewall rules using netsh.
/// These rules serve as a backup/fallback for WFP dynamic filters.
/// Rules are idempotent - safe to call multiple times.
/// </summary>
public class NetshFirewallManager
{
    private readonly ILogger<NetshFirewallManager> _logger;

    // Rule name constants - must match installer.nsh
    private const string RULE_WG_UDP_IN = "WireDog-WG-UDP-In";
    private const string RULE_WG_UDP_OUT = "WireDog-WG-UDP-Out";
    private const string RULE_TUNNEL_OUT = "WireDog-Tunnel-Out";
    private const string RULE_DNS_UDP_OUT = "WireDog-DNS-UDP-Out";
    private const string RULE_DNS_TCP_OUT = "WireDog-DNS-TCP-Out";
    private const string RULE_SERVER_PREFIX = "WireDog-Server-";

    public NetshFirewallManager(ILogger<NetshFirewallManager> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Ensure all required persistent firewall rules exist.
    /// Safe to call multiple times - will not create duplicates.
    /// </summary>
    public void EnsureRulesExist()
    {
        _logger.LogInformation("[Firewall] Verifying persistent firewall rules...");

        try
        {
            // Check and create each rule if missing
            EnsureRule(RULE_WG_UDP_IN, "dir=in action=allow protocol=UDP localport=51820");
            EnsureRule(RULE_WG_UDP_OUT, "dir=out action=allow protocol=UDP remoteport=51820");
            EnsureRule(RULE_TUNNEL_OUT, "dir=out action=allow localip=10.0.0.0/8");
            EnsureRule(RULE_DNS_UDP_OUT, "dir=out action=allow protocol=UDP remoteport=53");
            EnsureRule(RULE_DNS_TCP_OUT, "dir=out action=allow protocol=TCP remoteport=53");

            _logger.LogInformation("[Firewall] Persistent firewall rules verified");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Firewall] Failed to verify firewall rules (non-fatal)");
        }
    }

    /// <summary>
    /// Add a server-specific outbound rule for VPN connection.
    /// Call this before establishing a VPN tunnel.
    /// </summary>
    public void AddServerRule(string serverIp, ushort port, bool isTcp)
    {
        var ruleName = $"{RULE_SERVER_PREFIX}{serverIp}";
        var protocol = isTcp ? "TCP" : "UDP";

        _logger.LogInformation("[Firewall] Adding server rule: {RuleName} ({Ip}:{Port}/{Protocol})",
            ruleName, serverIp, port, protocol);

        try
        {
            // Delete existing rule first (in case of stale rule with different port)
            DeleteRule(ruleName);

            // Create new rule
            var args = $"advfirewall firewall add rule name=\"{ruleName}\" " +
                       $"dir=out action=allow protocol={protocol} remoteip={serverIp} remoteport={port} enable=yes";

            var (exitCode, output) = RunNetsh(args);

            if (exitCode == 0)
            {
                _logger.LogInformation("[Firewall] Server rule added: {RuleName}", ruleName);
            }
            else
            {
                _logger.LogWarning("[Firewall] Failed to add server rule: {Output}", output);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Firewall] Failed to add server rule (non-fatal)");
        }
    }

    /// <summary>
    /// Remove a server-specific rule when disconnecting.
    /// </summary>
    public void RemoveServerRule(string serverIp)
    {
        var ruleName = $"{RULE_SERVER_PREFIX}{serverIp}";

        _logger.LogInformation("[Firewall] Removing server rule: {RuleName}", ruleName);

        try
        {
            DeleteRule(ruleName);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Firewall] Failed to remove server rule (non-fatal)");
        }
    }

    /// <summary>
    /// Remove all WireDog server rules.
    /// Useful for cleanup on service shutdown.
    /// </summary>
    public void RemoveAllServerRules()
    {
        _logger.LogInformation("[Firewall] Removing all server rules...");

        try
        {
            // netsh doesn't support wildcards, but we can query and delete
            var (exitCode, output) = RunNetsh("advfirewall firewall show rule name=all");

            if (exitCode == 0)
            {
                // Parse output to find WireDog-Server-* rules
                var lines = output.Split('\n');
                foreach (var line in lines)
                {
                    if (line.Contains(RULE_SERVER_PREFIX))
                    {
                        // Extract rule name from "Rule Name:    WireDog-Server-x.x.x.x"
                        var parts = line.Split(':');
                        if (parts.Length >= 2)
                        {
                            var ruleName = parts[1].Trim();
                            DeleteRule(ruleName);
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Firewall] Failed to remove all server rules");
        }
    }

    /// <summary>
    /// Check if a specific rule exists.
    /// </summary>
    public bool RuleExists(string ruleName)
    {
        try
        {
            var (exitCode, output) = RunNetsh($"advfirewall firewall show rule name=\"{ruleName}\"");
            return exitCode == 0 && !output.Contains("No rules match");
        }
        catch
        {
            return false;
        }
    }

    private void EnsureRule(string ruleName, string ruleSpec)
    {
        if (RuleExists(ruleName))
        {
            _logger.LogDebug("[Firewall] Rule exists: {RuleName}", ruleName);
            return;
        }

        _logger.LogInformation("[Firewall] Creating missing rule: {RuleName}", ruleName);

        var args = $"advfirewall firewall add rule name=\"{ruleName}\" {ruleSpec} enable=yes";
        var (exitCode, output) = RunNetsh(args);

        if (exitCode != 0)
        {
            _logger.LogWarning("[Firewall] Failed to create rule {RuleName}: {Output}", ruleName, output);
        }
    }

    private void DeleteRule(string ruleName)
    {
        var args = $"advfirewall firewall delete rule name=\"{ruleName}\"";
        RunNetsh(args);
    }

    private (int exitCode, string output) RunNetsh(string args)
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "netsh",
                    Arguments = args,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                }
            };

            process.Start();
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            process.WaitForExit(5000);

            var combinedOutput = string.IsNullOrEmpty(error) ? output : $"{output}\n{error}";
            return (process.ExitCode, combinedOutput);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Firewall] Failed to run netsh: {Args}", args);
            return (-1, ex.Message);
        }
    }
}
