namespace WireDog.Service.Wfp;

/// <summary>
/// WFP GUIDs for layers, sublayers, and callouts
/// These are defined in fwpmu.h
/// </summary>
public static class WfpGuids
{
    // ============ Layer GUIDs ============

    /// <summary>
    /// Outbound IP packet layer (IPv4)
    /// </summary>
    public static readonly Guid FWPM_LAYER_OUTBOUND_IPPACKET_V4 = new("1e5c9fae-8a84-4135-a331-950b54229ecd");

    /// <summary>
    /// Outbound IP packet layer (IPv6)
    /// </summary>
    public static readonly Guid FWPM_LAYER_OUTBOUND_IPPACKET_V6 = new("a3b3ab6b-3564-488c-9117-f34e82142763");

    /// <summary>
    /// Inbound IP packet layer (IPv4)
    /// </summary>
    public static readonly Guid FWPM_LAYER_INBOUND_IPPACKET_V4 = new("c86fd1bf-21cd-497e-a0bb-17425c885c58");

    /// <summary>
    /// Inbound IP packet layer (IPv6)
    /// </summary>
    public static readonly Guid FWPM_LAYER_INBOUND_IPPACKET_V6 = new("b5a230d0-a8c0-44f2-916e-991b53ded1f7");

    /// <summary>
    /// Outbound transport layer (IPv4)
    /// </summary>
    public static readonly Guid FWPM_LAYER_OUTBOUND_TRANSPORT_V4 = new("09e61aea-d214-46e2-9b21-b26b0b2f28c8");

    /// <summary>
    /// Outbound transport layer (IPv6)
    /// </summary>
    public static readonly Guid FWPM_LAYER_OUTBOUND_TRANSPORT_V6 = new("e1735bde-013f-4655-b351-a49e15762df0");

    /// <summary>
    /// Inbound transport layer (IPv4)
    /// </summary>
    public static readonly Guid FWPM_LAYER_INBOUND_TRANSPORT_V4 = new("5926dfc8-e3cf-4426-a283-dc393f5d0f9d");

    /// <summary>
    /// Inbound transport layer (IPv6)
    /// </summary>
    public static readonly Guid FWPM_LAYER_INBOUND_TRANSPORT_V6 = new("634a869f-fc23-4b90-b0c1-bf620a36ae6f");

    /// <summary>
    /// ALE (Application Layer Enforcement) connect layer (IPv4)
    /// </summary>
    public static readonly Guid FWPM_LAYER_ALE_AUTH_CONNECT_V4 = new("c38d57d1-05a7-4c33-904f-7fbceee60e82");

    /// <summary>
    /// ALE connect layer (IPv6)
    /// </summary>
    public static readonly Guid FWPM_LAYER_ALE_AUTH_CONNECT_V6 = new("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");

    /// <summary>
    /// ALE auth receive/accept layer (IPv4) - for inbound traffic authorization
    /// </summary>
    public static readonly Guid FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4 = new("e1cd9fe7-f4b5-4273-96c0-592e487b8650");

    /// <summary>
    /// ALE auth receive/accept layer (IPv6) - for inbound traffic authorization
    /// </summary>
    public static readonly Guid FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6 = new("a3b42c97-9f04-4672-b87e-cee9c483257f");

    /// <summary>
    /// ALE flow established layer (IPv4) - notifies when TCP connection established or non-TCP authorized
    /// </summary>
    public static readonly Guid FWPM_LAYER_ALE_FLOW_ESTABLISHED_V4 = new("af80470a-5596-4c13-9992-539e6fe57967");

    /// <summary>
    /// ALE flow established layer (IPv6) - notifies when TCP connection established or non-TCP authorized
    /// </summary>
    public static readonly Guid FWPM_LAYER_ALE_FLOW_ESTABLISHED_V6 = new("7021d2b3-dfa4-406e-afeb-6afaf7e70efd");

    // ============ Condition Field GUIDs ============

    /// <summary>
    /// IP local address
    /// </summary>
    public static readonly Guid FWPM_CONDITION_IP_LOCAL_ADDRESS = new("d9ee00de-c1ef-4617-bfe3-ffd8f5a08957");

    /// <summary>
    /// IP remote address
    /// </summary>
    public static readonly Guid FWPM_CONDITION_IP_REMOTE_ADDRESS = new("b235ae9a-1d64-49b8-a44c-5ff3d9095045");

    /// <summary>
    /// IP protocol
    /// </summary>
    public static readonly Guid FWPM_CONDITION_IP_PROTOCOL = new("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7");

    /// <summary>
    /// IP local port
    /// </summary>
    public static readonly Guid FWPM_CONDITION_IP_LOCAL_PORT = new("0c1ba1af-5765-453f-af22-a8f791ac775b");

    /// <summary>
    /// IP remote port
    /// </summary>
    public static readonly Guid FWPM_CONDITION_IP_REMOTE_PORT = new("c35a604d-d22b-4e1a-91b4-68f674ee674b");

    /// <summary>
    /// Interface index
    /// </summary>
    public static readonly Guid FWPM_CONDITION_INTERFACE_INDEX = new("667fd755-d695-434a-8af5-d3835a1259bc");

    /// <summary>
    /// Interface type (tunnel, loopback, etc.)
    /// </summary>
    public static readonly Guid FWPM_CONDITION_INTERFACE_TYPE = new("daf8cd14-e09e-4c93-a5ae-c5c13b73ffca");

    /// <summary>
    /// Flags (loopback, etc.)
    /// </summary>
    public static readonly Guid FWPM_CONDITION_FLAGS = new("632ce23b-5167-435c-86d7-e903684aa80c");

    // ============ WireDog Provider and Sublayer GUIDs ============

    /// <summary>
    /// WireDog provider GUID
    /// </summary>
    public static readonly Guid WIREDOG_PROVIDER = new("a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d");

    /// <summary>
    /// WireDog sublayer GUID
    /// </summary>
    public static readonly Guid WIREDOG_SUBLAYER = new("b2c3d4e5-f6a7-5b6c-9d0e-1f2a3b4c5d6e");

    /// <summary>
    /// Kill switch filter GUID prefix
    /// </summary>
    public static readonly Guid WIREDOG_FILTER_KILLSWITCH = new("9d0e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6");

    /// <summary>
    /// WireDog persistent provider GUID (for advanced kill switch - survives reboot)
    /// </summary>
    public static readonly Guid WIREDOG_PERSISTENT_PROVIDER = new("c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f");

    /// <summary>
    /// WireDog persistent sublayer GUID (for advanced kill switch - survives reboot)
    /// </summary>
    public static readonly Guid WIREDOG_PERSISTENT_SUBLAYER = new("d2e3f4a5-b6c7-8d9e-0f1a-2b3c4d5e6f7a");
}

/// <summary>
/// WFP constants
/// </summary>
public static class WfpConstants
{
    // Session flags
    public const uint FWPM_SESSION_FLAG_DYNAMIC = 0x00000001;

    // Provider flags
    public const uint FWPM_PROVIDER_FLAG_PERSISTENT = 0x00000001;

    // Filter flags
    public const uint FWPM_FILTER_FLAG_PERSISTENT = 0x00000001;
    public const uint FWPM_FILTER_FLAG_BOOTTIME = 0x00000002;
    public const uint FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT = 0x00000008;

    // Action types (must include FWP_ACTION_FLAG_TERMINATING = 0x1000)
    public const uint FWP_ACTION_BLOCK = 0x00001001;   // Block and terminate
    public const uint FWP_ACTION_PERMIT = 0x00001002;  // Permit and terminate

    // Match types
    public const uint FWP_MATCH_EQUAL = 0;
    public const uint FWP_MATCH_NOT_EQUAL = 7;
    public const uint FWP_MATCH_RANGE = 5;
    public const uint FWP_MATCH_FLAGS_ALL_SET = 1;

    // Data types
    public const uint FWP_EMPTY = 0;
    public const uint FWP_UINT8 = 1;
    public const uint FWP_UINT16 = 2;
    public const uint FWP_UINT32 = 3;
    public const uint FWP_UINT64 = 4;
    public const uint FWP_BYTE_ARRAY16 = 5;
    // FWP_V4_ADDR_MASK and FWP_V6_ADDR_MASK come after FWP_SINGLE_DATA_TYPE_MAX (0xFF)
    public const uint FWP_V4_ADDR_MASK = 0x100;  // 256
    public const uint FWP_V6_ADDR_MASK = 0x101;  // 257
    public const uint FWP_RANGE = 0x102;         // 258


    // Protocol numbers
    public const byte IPPROTO_UDP = 17;
    public const byte IPPROTO_TCP = 6;

    // Interface types
    public const uint IF_TYPE_SOFTWARE_LOOPBACK = 24;
    public const uint IF_TYPE_TUNNEL = 131;

    // Condition flags
    public const uint FWP_CONDITION_FLAG_IS_LOOPBACK = 0x00000001;

    // Weight values
    public const ulong WEIGHT_MAX = 0xFFFFFFFFFFFFFFFF;
    public const ulong WEIGHT_HIGH = 0x8000000000000000;
    public const ulong WEIGHT_NORMAL = 0x4000000000000000;
    public const ulong WEIGHT_LOW = 0x2000000000000000;
    public const ulong WEIGHT_MIN = 0x0000000000000001;

    // RPC authentication
    public const uint RPC_C_AUTHN_DEFAULT = 0xFFFFFFFF;
}
