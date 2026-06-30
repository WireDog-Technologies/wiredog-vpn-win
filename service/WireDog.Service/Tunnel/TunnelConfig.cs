using System.Text;
using WireDog.Service.Ipc;

namespace WireDog.Service.Tunnel;

/// <summary>
/// WireGuard/AWG tunnel configuration
/// </summary>
public class TunnelConfig
{
    public string PrivateKey { get; set; } = "";
    public string Address { get; set; } = "";
    public string Dns { get; set; } = "";
    public string ServerPublicKey { get; set; } = "";
    public string Endpoint { get; set; } = "";
    public string AllowedIPs { get; set; } = "";
    public int PersistentKeepalive { get; set; } = 25;
    public AwgParams? Awg { get; set; }

    /// <summary>
    /// Create config from IPC parameters
    /// </summary>
    public static TunnelConfig FromParams(WireGuardConfigParams p)
    {
        return new TunnelConfig
        {
            PrivateKey = p.PrivateKey,
            Address = p.Address,
            Dns = p.Dns,
            ServerPublicKey = p.ServerPublicKey,
            Endpoint = p.Endpoint,
            AllowedIPs = p.AllowedIPs,
            PersistentKeepalive = p.PersistentKeepalive,
            Awg = p.Awg
        };
    }

    /// <summary>
    /// Generate WireGuard config file content
    /// </summary>
    public string ToConfigFile()
    {
        var sb = new StringBuilder();
        sb.AppendLine("[Interface]");
        sb.AppendLine($"PrivateKey = {PrivateKey}");
        sb.AppendLine($"Address = {Address}");
        sb.AppendLine($"DNS = {Dns}");
        sb.AppendLine();
        sb.AppendLine("[Peer]");
        sb.AppendLine($"PublicKey = {ServerPublicKey}");
        sb.AppendLine($"Endpoint = {Endpoint}");
        sb.AppendLine($"AllowedIPs = {AllowedIPs}");
        sb.AppendLine($"PersistentKeepalive = {PersistentKeepalive}");
        return sb.ToString();
    }

    /// <summary>
    /// Get the assigned IP (without CIDR notation)
    /// </summary>
    public string GetAssignedIp()
    {
        return Address.Split('/')[0];
    }

    /// <summary>
    /// Get the VPN server IP (without port)
    /// </summary>
    public string GetServerIp()
    {
        return Endpoint.Split(':')[0];
    }
}
