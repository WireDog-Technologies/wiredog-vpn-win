using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace WireDog.Service.Tunnel;

/// <summary>
/// Generates WireGuard configuration files in standard .conf format
/// </summary>
public static class ConfigFileWriter
{
    private static readonly string ConfigDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "WireDog", "tunnels");

    static ConfigFileWriter()
    {
        Directory.CreateDirectory(ConfigDirectory);
    }

    /// <summary>
    /// Write WireGuard configuration to file
    /// Returns the path to the written config file
    /// </summary>
    public static string WriteConfig(TunnelConfig config)
    {
        var configPath = Path.Combine(ConfigDirectory, "WireDog.conf");

        var sb = new StringBuilder();

        // Interface section
        sb.AppendLine("[Interface]");
        sb.AppendLine($"PrivateKey = {config.PrivateKey}");

        // Add both IPv4 and IPv6 addresses if provided
        var addresses = new List<string>();
        if (!string.IsNullOrEmpty(config.Address))
        {
            addresses.Add(config.Address);
        }
        // IPv6 address would be in a separate field, add if present
        // For now, assume config.Address handles both or just IPv4

        foreach (var addr in addresses)
        {
            sb.AppendLine($"Address = {addr}");
        }

        // DNS servers
        if (!string.IsNullOrEmpty(config.Dns))
        {
            var dnsServers = config.Dns.Split(',', StringSplitOptions.RemoveEmptyEntries);
            foreach (var dns in dnsServers)
            {
                sb.AppendLine($"DNS = {dns.Trim()}");
            }
        }

        // AWG obfuscation parameters
        if (config.Awg != null)
        {
            sb.AppendLine($"Jc = {config.Awg.Jc}");
            sb.AppendLine($"Jmin = {config.Awg.Jmin}");
            sb.AppendLine($"Jmax = {config.Awg.Jmax}");
            sb.AppendLine($"S1 = {config.Awg.S1}");
            sb.AppendLine($"S2 = {config.Awg.S2}");
            sb.AppendLine($"H1 = {config.Awg.H1}");
            sb.AppendLine($"H2 = {config.Awg.H2}");
            sb.AppendLine($"H3 = {config.Awg.H3}");
            sb.AppendLine($"H4 = {config.Awg.H4}");
        }

        sb.AppendLine();

        // Peer section
        sb.AppendLine("[Peer]");
        sb.AppendLine($"PublicKey = {config.ServerPublicKey}");
        sb.AppendLine($"Endpoint = {config.Endpoint}");

        // Allowed IPs
        if (!string.IsNullOrEmpty(config.AllowedIPs))
        {
            var ips = config.AllowedIPs.Split(',', StringSplitOptions.RemoveEmptyEntries);
            var allowedIpsLine = string.Join(", ", ips.Select(ip => ip.Trim()));
            sb.AppendLine($"AllowedIPs = {allowedIpsLine}");
        }

        // Persistent keepalive
        if (config.PersistentKeepalive > 0)
        {
            sb.AppendLine($"PersistentKeepalive = {config.PersistentKeepalive}");
        }

        // Write to file and restrict ACL to SYSTEM + Administrators only
        File.WriteAllText(configPath, sb.ToString());
        RestrictFileAcl(configPath);

        return configPath;
    }

    /// <summary>
    /// Delete the config file after disconnect
    /// </summary>
    public static void DeleteConfig()
    {
        var configPath = Path.Combine(ConfigDirectory, "WireDog.conf");
        try
        {
            if (File.Exists(configPath))
            {
                File.Delete(configPath);
            }
        }
        catch (Exception)
        {
            // Ignore deletion errors
        }
    }

    /// <summary>
    /// Get the config file path
    /// </summary>
    public static string GetConfigPath()
    {
        return Path.Combine(ConfigDirectory, "WireDog.conf");
    }

    /// <summary>
    /// Restrict file to SYSTEM and Administrators only (removes inherited/user ACEs)
    /// </summary>
    private static void RestrictFileAcl(string path)
    {
        var fileInfo = new FileInfo(path);
        var security = fileInfo.GetAccessControl();

        // Remove all inherited rules
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            security.RemoveAccessRule(rule);
        }

        // Grant SYSTEM full control
        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            FileSystemRights.FullControl,
            AccessControlType.Allow));

        // Grant Administrators full control
        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            FileSystemRights.FullControl,
            AccessControlType.Allow));

        fileInfo.SetAccessControl(security);
    }
}
