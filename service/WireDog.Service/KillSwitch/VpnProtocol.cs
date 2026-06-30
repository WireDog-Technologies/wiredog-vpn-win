namespace WireDog.Service.KillSwitch;

/// <summary>
/// Supported VPN protocols
/// </summary>
public enum VpnProtocolType
{
    WireGuard,
    OpenVpnUdp,
    OpenVpnTcp
}

/// <summary>
/// Protocol configuration for kill switch filters
/// </summary>
public class VpnProtocolConfig
{
    public VpnProtocolType Type { get; }
    public ushort Port { get; }
    public bool IsTcp { get; }

    private VpnProtocolConfig(VpnProtocolType type, ushort port, bool isTcp)
    {
        Type = type;
        Port = port;
        IsTcp = isTcp;
    }

    /// <summary>
    /// WireGuard: UDP/51820
    /// </summary>
    public static VpnProtocolConfig WireGuard => new(VpnProtocolType.WireGuard, 51820, false);

    /// <summary>
    /// OpenVPN UDP: UDP/1194
    /// </summary>
    public static VpnProtocolConfig OpenVpnUdp => new(VpnProtocolType.OpenVpnUdp, 1194, false);

    /// <summary>
    /// OpenVPN TCP: TCP/443
    /// </summary>
    public static VpnProtocolConfig OpenVpnTcp => new(VpnProtocolType.OpenVpnTcp, 443, true);

    /// <summary>
    /// Create config from protocol type
    /// </summary>
    public static VpnProtocolConfig FromType(VpnProtocolType type) => type switch
    {
        VpnProtocolType.WireGuard => WireGuard,
        VpnProtocolType.OpenVpnUdp => OpenVpnUdp,
        VpnProtocolType.OpenVpnTcp => OpenVpnTcp,
        _ => WireGuard
    };

    /// <summary>
    /// Create config with custom port (e.g., WireGuard on non-standard port)
    /// </summary>
    public static VpnProtocolConfig Custom(VpnProtocolType type, ushort port)
    {
        bool isTcp = type == VpnProtocolType.OpenVpnTcp;
        return new VpnProtocolConfig(type, port, isTcp);
    }
}
