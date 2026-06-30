namespace WireDog.Service.KillSwitch;

/// <summary>
/// Kill switch state machine states
/// </summary>
public enum KillSwitchState
{
    /// <summary>
    /// Kill switch is disabled, no filters active
    /// </summary>
    Disabled,

    /// <summary>
    /// Bootstrap phase: minimal allowlist before tunnel establishment
    /// Allows: VPN server endpoint, DHCP, DNS, LAN, loopback
    /// Blocks: All other traffic
    /// </summary>
    Bootstrap,

    /// <summary>
    /// Connected phase: strict lockdown with tunnel interface permitted
    /// Allows: VPN tunnel interface, VPN server (keep-alive), DHCP, DNS, LAN, loopback
    /// Blocks: All other traffic
    /// </summary>
    Connected,

    /// <summary>
    /// Connected with persistent block-all filters active.
    /// Both dynamic (tunnel permits) and persistent (block-all) filters are active.
    /// Dynamic permits override persistent blocks while connected.
    /// </summary>
    ConnectedPersistent,

    /// <summary>
    /// Disconnected but persistent block-all filters remain active.
    /// No tunnel — all internet blocked. Loopback/DHCP/LAN still allowed.
    /// Only DisablePersistentBlock() or a new connection can exit this state.
    /// </summary>
    PersistentBlock
}
