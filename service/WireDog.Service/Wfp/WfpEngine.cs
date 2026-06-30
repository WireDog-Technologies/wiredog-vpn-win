using System.ComponentModel;
using System.Net;
using System.Runtime.InteropServices;
using System.Net.NetworkInformation;

namespace WireDog.Service.Wfp;

/// <summary>
/// WFP Engine wrapper - manages WFP session and provides high-level filter operations
/// Uses dynamic session for automatic cleanup on process exit (fail-safe kill switch)
/// All filters use IP packet layer (FWPM_LAYER_OUTBOUND_IPPACKET_V4/V6) for consistency
/// </summary>
public class WfpEngine : IDisposable
{
    private readonly ILogger<WfpEngine> _logger;
    private IntPtr _engineHandle;
    private bool _isOpen;
    private bool _disposed;
    private readonly List<ulong> _filterIds = new();

    // Persistent session (for advanced kill switch - survives process exit and reboot)
    private IntPtr _persistentEngineHandle;
    private bool _isPersistentOpen;
    private readonly List<ulong> _persistentFilterIds = new();

    public bool IsOpen => _isOpen;
    public bool IsPersistentOpen => _isPersistentOpen;

    public WfpEngine(ILogger<WfpEngine> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Open WFP engine with DYNAMIC session flag
    /// This ensures all filters are automatically removed when the process exits
    /// </summary>
    public void Open()
    {
        if (_isOpen) return;

        var session = new FWPM_SESSION0
        {
            displayData = new FWPM_DISPLAY_DATA0
            {
                name = "WireDog",
                description = "WireDog Kill Switch Session"
            },
            flags = WfpConstants.FWPM_SESSION_FLAG_DYNAMIC, // KEY: Auto-cleanup on crash
            txnWaitTimeoutInMSec = 5000
        };

        uint result = WfpNative.FwpmEngineOpen0(
            null,
            WfpConstants.RPC_C_AUTHN_DEFAULT,
            IntPtr.Zero,
            ref session,
            out _engineHandle);

        if (result != 0)
        {
            throw new Win32Exception((int)result, $"FwpmEngineOpen0 failed with error {result}");
        }

        _isOpen = true;
        _logger.LogInformation("WFP engine opened with dynamic session (handle: {Handle})", _engineHandle);

        // Register our provider and sublayer
        RegisterProviderAndSublayer();
    }

    /// <summary>
    /// Close WFP engine - all dynamic filters are automatically removed
    /// </summary>
    public void Close()
    {
        if (!_isOpen) return;

        _filterIds.Clear();

        if (_engineHandle != IntPtr.Zero)
        {
            WfpNative.FwpmEngineClose0(_engineHandle);
            _engineHandle = IntPtr.Zero;
        }

        _isOpen = false;
        _logger.LogInformation("WFP engine closed - all dynamic filters removed");
    }

    /// <summary>
    /// Force-clean all WireDog WFP objects using a temporary static (non-dynamic) session.
    /// A dynamic session cannot delete objects owned by a different (dead) session — only a
    /// static session has broad enough access to clean up orphaned objects from any session.
    /// Safe to call even when no orphaned objects exist (delete calls return FWP_E_NOT_FOUND).
    /// </summary>
    private void CleanupOrphanedObjectsWithStaticSession()
    {
        _logger.LogInformation("[WFP] Opening static session to clean up any orphaned WireDog objects...");

        var session = new FWPM_SESSION0
        {
            displayData = new FWPM_DISPLAY_DATA0
            {
                name = "WireDog-Cleanup",
                description = "WireDog Cleanup Session"
            },
            flags = 0, // Static session — can delete objects from any (including dead) session
            txnWaitTimeoutInMSec = 5000
        };

        uint result = WfpNative.FwpmEngineOpen0(null, WfpConstants.RPC_C_AUTHN_DEFAULT, IntPtr.Zero, ref session, out IntPtr cleanupHandle);
        if (result != 0)
        {
            _logger.LogWarning("[WFP] Could not open static cleanup session: 0x{Error:X8}", result);
            return;
        }

        try
        {
            // Step 1: enumerate and delete all filters in our sublayer
            result = WfpNative.FwpmFilterCreateEnumHandle0(cleanupHandle, IntPtr.Zero, out IntPtr enumHandle);
            if (result == 0)
            {
                var filtersToDelete = new List<ulong>();
                var sublayerKey = WfpGuids.WIREDOG_SUBLAYER;

                try
                {
                    const uint BATCH_SIZE = 100;
                    while (true)
                    {
                        result = WfpNative.FwpmFilterEnum0(cleanupHandle, enumHandle, BATCH_SIZE, out IntPtr entries, out uint numReturned);
                        if (result != 0 || numReturned == 0) break;

                        try
                        {
                            for (int i = 0; i < numReturned; i++)
                            {
                                IntPtr filterPtr = Marshal.ReadIntPtr(entries, i * IntPtr.Size);
                                var filter = Marshal.PtrToStructure<FWPM_FILTER0>(filterPtr);
                                if (filter.subLayerKey == sublayerKey)
                                    filtersToDelete.Add(filter.filterId);
                            }
                        }
                        finally
                        {
                            var entriesRef = entries;
                            WfpNative.FwpmFreeMemory0(ref entriesRef);
                        }
                    }
                }
                finally
                {
                    WfpNative.FwpmFilterDestroyEnumHandle0(cleanupHandle, enumHandle);
                }

                if (filtersToDelete.Count > 0)
                {
                    _logger.LogInformation("[WFP] Static session: deleting {Count} orphaned filters", filtersToDelete.Count);
                    foreach (var filterId in filtersToDelete)
                        WfpNative.FwpmFilterDeleteById0(cleanupHandle, filterId);
                }
            }

            // Step 2: delete sublayer (FWP_E_NOT_FOUND is fine — means it was already gone)
            var sublayerGuid = WfpGuids.WIREDOG_SUBLAYER;
            result = WfpNative.FwpmSubLayerDeleteByKey0(cleanupHandle, ref sublayerGuid);
            if (result != 0 && result != 0x80320007) // 0x80320007 = FWP_E_SUBLAYER_NOT_FOUND
                _logger.LogWarning("[WFP] Static session: sublayer delete returned 0x{Result:X8}", result);

            // Step 3: delete provider
            var providerGuid = WfpGuids.WIREDOG_PROVIDER;
            result = WfpNative.FwpmProviderDeleteByKey0(cleanupHandle, ref providerGuid);
            if (result != 0 && result != 0x80320005) // 0x80320005 = FWP_E_PROVIDER_NOT_FOUND
                _logger.LogWarning("[WFP] Static session: provider delete returned 0x{Result:X8}", result);

            _logger.LogInformation("[WFP] Static cleanup session complete");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[WFP] Exception during static cleanup (non-fatal)");
        }
        finally
        {
            WfpNative.FwpmEngineClose0(cleanupHandle);
        }
    }

    private void RegisterProviderAndSublayer()
    {
        _logger.LogInformation("Registering WFP provider and sublayer...");

        // Use a static session to force-delete any objects left by a previous (dead) session.
        // A live dynamic session cannot operate on objects it doesn't own — FWP_E_WRONG_SESSION.
        CleanupOrphanedObjectsWithStaticSession();

        // Begin transaction in the dynamic session to register fresh provider + sublayer
        uint result = WfpNative.FwpmTransactionBegin0(_engineHandle, 0);
        if (result != 0)
        {
            _logger.LogError("FwpmTransactionBegin0 failed: {Error:X8} ({ErrorDesc})", result, GetErrorDescription(result));
            return;
        }

        try
        {
            // Add provider
            var providerKey = WfpGuids.WIREDOG_PROVIDER;
            _logger.LogDebug("Adding provider: {ProviderId}", providerKey);

            var provider = new FWPM_PROVIDER0
            {
                providerKey = providerKey,
                displayData = new FWPM_DISPLAY_DATA0
                {
                    name = "WireDog",
                    description = "WireDog VPN Client"
                },
                flags = 0
            };

            result = WfpNative.FwpmProviderAdd0(_engineHandle, ref provider, IntPtr.Zero);
            if (result != 0)
                _logger.LogWarning("FwpmProviderAdd0 failed: {Error:X8} ({ErrorDesc})", result, GetErrorDescription(result));
            else
                _logger.LogInformation("Provider registered successfully");

            // Add sublayer with high weight (execute before Windows Firewall)
            var sublayerKey = WfpGuids.WIREDOG_SUBLAYER;
            _logger.LogDebug("Adding sublayer: {SublayerId}", sublayerKey);

            var providerKeyPtr = Marshal.AllocHGlobal(Marshal.SizeOf<Guid>());
            Marshal.StructureToPtr(providerKey, providerKeyPtr, false);

            var sublayer = new FWPM_SUBLAYER0
            {
                subLayerKey = sublayerKey,
                displayData = new FWPM_DISPLAY_DATA0
                {
                    name = "WireDog Kill Switch",
                    description = "WireDog Kill Switch Sublayer"
                },
                flags = 0,
                providerKey = providerKeyPtr,
                weight = 0xFFFF // Highest weight - execute before other sublayers
            };

            result = WfpNative.FwpmSubLayerAdd0(_engineHandle, ref sublayer, IntPtr.Zero);
            Marshal.FreeHGlobal(providerKeyPtr);

            if (result != 0)
                _logger.LogError("FwpmSubLayerAdd0 failed: {Error:X8} ({ErrorDesc})", result, GetErrorDescription(result));
            else
                _logger.LogInformation("Sublayer registered successfully");

            // Commit transaction
            result = WfpNative.FwpmTransactionCommit0(_engineHandle);
            if (result != 0)
                _logger.LogError("FwpmTransactionCommit0 failed: {Error:X8} ({ErrorDesc})", result, GetErrorDescription(result));
            else
                _logger.LogInformation("Transaction committed successfully");

            _logger.LogInformation("Provider and sublayer registration complete");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exception during provider/sublayer registration");
            WfpNative.FwpmTransactionAbort0(_engineHandle);
            throw;
        }
    }

    /// <summary>
    /// Get human-readable description of WFP error codes
    /// </summary>
    private static string GetErrorDescription(uint errorCode)
    {
        return errorCode switch
        {
            0x80320015 => "FWP_E_INVALID_PARAMETER",
            0x80320009 => "FWP_E_ALREADY_EXISTS",
            0x80320008 => "FWP_E_FILTER_NOT_FOUND",
            0x8032000A => "FWP_E_IN_USE",
            0x8032000C => "FWP_E_WRONG_SESSION",
            0x80320001 => "FWP_E_OUT_OF_BOUNDS",
            0x80320002 => "FWP_E_INVALID_METADATA",
            0x80320003 => "FWP_E_INCOMPATIBLE_LAYER",
            0x80320004 => "FWP_E_INVALID_HEADER",
            0x80320005 => "FWP_E_INVALID_OPTION",
            0x80320026 => "FWP_E_MATCH_TYPE_MISMATCH",
            0x80320027 => "FWP_E_TYPE_MISMATCH",
            _ => "UNKNOWN"
        };
    }

    /// <summary>
    /// LEGACY - Commenting out for potential revival later
    /// Add a permit filter for a specific IPv4 address (VPN server)
    /// Uses IP packet layer with IP + protocol + port matching
    /// </summary>
    /*
    public ulong AddPermitIpv4Filter(string name, string ipAddress, ulong weight = 100)
    {
        EnsureOpen();

        var ip = IPAddress.Parse(ipAddress);
        var ipBytes = ip.GetAddressBytes();
        // Use BitConverter to create little-endian (host byte order) uint32
        // This is the correct format for WFP IP address matching
        var ipUint = BitConverter.ToUInt32(ipBytes, 0);

        return AddVpnServerFilter(name, WfpConstants.FWP_ACTION_PERMIT, ipUint, weight);
    } */

    /// <summary>
    /// Add a permit filter for a subnet (e.g., 192.168.1.0/24)
    /// Uses IP packet layer with subnet mask matching
    /// </summary>
    public ulong AddPermitSubnetFilter(string name, string subnet, ulong weight = 100)
    {
        EnsureOpen();
        _logger.LogWarning("AddPermitSubnetFilter called but IP-only filters are not valid at ALE. Skipping subnet {Subnet}.", subnet);
        return 0; // Return dummy ID
    }

    /// <summary>
    /// Add a permit filter for traffic from a specific interface (not used in ALE-only architecture)
    /// Interface-only conditions are invalid at ALE without protocol/port context
    /// </summary>
    [Obsolete("Interface-only permits are invalid at ALE. Use protocol/port-based permits instead.")]
    public ulong AddPermitInterfaceFilter(string name, int interfaceIndex, ulong weight = 100)
    {
        EnsureOpen();
        _logger.LogWarning("AddPermitInterfaceFilter called but interface-only filters are not valid at ALE. Skipping.");
        return 0; // Return dummy ID
    }

    /// <summary>
    /// Add a permit filter for IPv4 loopback traffic (127.0.0.0/8)
    /// Uses IP address range matching at IP packet layer
    /// </summary>
    public ulong AddPermitLoopbackFilter(string name, ulong weight = 200)
    {
        EnsureOpen();

        _logger.LogInformation("[Loopback] Creating permit filter for IPv4 loopback traffic (127.0.0.0/8)");

        // Use IP address range matching for loopback subnet 127.0.0.0/8
        // Range: 127.0.0.0 - 127.255.255.255 (host byte order)
        uint startIp = 0x7F000000; // 127.0.0.0
        uint endIp = 0x7FFFFFFF;   // 127.255.255.255

        var range = new FWP_RANGE0
        {
            valueLow = new FWP_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = startIp }
            },
            valueHigh = new FWP_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = endIp }
            }
        };

        var rangePtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWP_RANGE0>());
        Marshal.StructureToPtr(range, rangePtr, false);

        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_RANGE,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_RANGE,
                value = new FWP_VALUE0_UNION { rangeValue = rangePtr }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // OUTBOUND permit at IPPACKET layer (for raw IP/ICMP)
            var ipPacketId = AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            // OUTBOUND permit at TRANSPORT layer (for TCP/UDP to localhost)
            // CRITICAL: Without this, localhost TCP connections (like dev servers) are blocked
            _logger.LogInformation("[Loopback] Adding TRANSPORT layer permit for IPv4 loopback (localhost services)");
            AddFilterInternal($"{name} (Transport)", WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            return ipPacketId;
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
            Marshal.FreeHGlobal(rangePtr);
        }
    }

    /// <summary>
    /// Add a permit filter for IPv6 loopback traffic (::1)
    /// Uses FLAGS condition to match loopback traffic at IP packet layer
    /// </summary>
    public ulong AddPermitLoopbackIpv6Filter(string name, ulong weight = 200)
    {
        EnsureOpen();

        _logger.LogInformation("[Loopback] Creating permit filter for IPv6 loopback traffic");

        // IPv6 loopback ::1
        byte[] loopback = new byte[17];
        loopback[15] = 1; // ::1
        loopback[16] = 128; // prefix length

        IntPtr ipv6Ptr = Marshal.AllocHGlobal(17);
        Marshal.Copy(loopback, 0, ipv6Ptr, 17);

        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_V6_ADDR_MASK,
                value = new FWP_VALUE0_UNION { ptr = ipv6Ptr }
            }
        };

        IntPtr conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // OUTBOUND permit at IPPACKET layer (for raw IPv6)
            var ipPacketId = AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            // OUTBOUND permit at TRANSPORT layer (for TCP/UDP to localhost)
            _logger.LogInformation("[Loopback] Adding TRANSPORT layer permit for IPv6 loopback (localhost services)");
            AddFilterInternal($"{name} (Transport)", WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            return ipPacketId;
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
            Marshal.FreeHGlobal(ipv6Ptr);
        }
    }

    /// <summary>
    /// Add a permit filter for DHCP traffic (UDP 67/68)
    /// </summary>
    public ulong AddPermitDhcpFilter(string name, ulong weight = 100)
    {
        EnsureOpen();

        // Allow DHCP client (port 68) to DHCP server (port 67)
        return AddUdpPortFilter(name, WfpConstants.FWP_ACTION_PERMIT, 68, 67, weight);
    }

    /// <summary>
    /// Add block-all filters at BOTH transport and IP packet layers.
    /// Transport layer catches TCP/UDP traffic (where DNS/DHCP permits live).
    /// IP packet layer catches everything else (ICMP, raw sockets, etc).
    /// Returns list of filter IDs (2 filters).
    /// </summary>
    public List<ulong> AddBlockAllFilters(string name, ulong weight = 1)
    {
        EnsureOpen();
        var filterIds = new List<ulong>();

        // Block at transport layer (for TCP/UDP - where DNS/DHCP permits work)
        var transportId = AddBlockAllFilterInternal($"{name} (Transport)", WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4, weight);
        filterIds.Add(transportId);

        // Block at IP packet layer (for ICMP, raw sockets, and anything that doesn't hit transport)
        var ipPacketId = AddBlockAllFilterInternal($"{name} (IPPacket)", WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4, weight);
        filterIds.Add(ipPacketId);

        return filterIds;
    }

    /// <summary>
    /// Add a block-all filter (single layer version for backwards compatibility)
    /// </summary>
    public ulong AddBlockAllFilter(string name, ulong weight = 1)
    {
        EnsureOpen();
        // Use transport layer so weight system works with DNS/DHCP permits
        return AddBlockAllFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4, weight);
    }

    /// <summary>
    /// Add block-all filters for IPv6 at BOTH transport and IP packet layers.
    /// </summary>
    public List<ulong> AddBlockAllIpv6Filters(string name, ulong weight = 1)
    {
        EnsureOpen();
        var filterIds = new List<ulong>();

        var transportId = AddBlockAllFilterInternal($"{name} (Transport)", WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V6, weight);
        filterIds.Add(transportId);

        var ipPacketId = AddBlockAllFilterInternal($"{name} (IPPacket)", WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V6, weight);
        filterIds.Add(ipPacketId);

        return filterIds;
    }

    /// <summary>
    /// Add a block-all filter for IPv6 (single layer version)
    /// </summary>
    public ulong AddBlockAllIpv6Filter(string name, ulong weight = 1)
    {
        EnsureOpen();
        return AddBlockAllFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V6, weight);
    }

    /// <summary>
    /// Add a permit filter for DNS traffic (UDP/TCP port 53)
    /// </summary>
    public ulong AddPermitDnsFilter(string name, ulong weight = 100)
    {
        EnsureOpen();
        // Allow DNS on remote port 53 (both UDP and TCP use same port)
        return AddRemotePortFilter(name, WfpConstants.FWP_ACTION_PERMIT, 53, weight);
    }

    /// <summary>
    /// Block ALL DNS traffic (port 53) - IPv4
    /// Uses IP PACKET layer to catch all DNS packets (including reused socket connections)
    /// Conditions: UDP protocol AND remote port 53
    /// </summary>
    public ulong AddBlockAllDns(string name, ulong weight = 165)
    {
        EnsureOpen();

        _logger.LogInformation("[DNS BLOCK] Creating block filter for all DNS traffic (port 53)");

        var conditions = new FWPM_FILTER_CONDITION0[2];

        // Condition 1: Protocol = UDP (most DNS)
        conditions[0] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_PROTOCOL,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT8,
                value = new FWP_VALUE0_UNION { uint8 = WfpConstants.IPPROTO_UDP }
            }
        };

        // Condition 2: Remote port = 53
        conditions[1] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_PORT,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT16,
                value = new FWP_VALUE0_UNION { uint16 = 53 }
            }
        };

        _logger.LogInformation("[DNS BLOCK] Conditions:");
        _logger.LogInformation("  [1] IP_PROTOCOL = UDP (17)");
        _logger.LogInformation("  [2] IP_REMOTE_PORT = 53");
        _logger.LogInformation("[DNS BLOCK] Purpose: Block DNS to any interface except tunnel (lower weight than permit filters)");

        int size = Marshal.SizeOf<FWPM_FILTER_CONDITION0>();
        IntPtr conditionsPtr = Marshal.AllocHGlobal(size * conditions.Length);

        try
        {
            for (int i = 0; i < conditions.Length; i++)
            {
                IntPtr ptr = IntPtr.Add(conditionsPtr, i * size);
                Marshal.StructureToPtr(conditions[i], ptr, false);
            }

            // Use OUTBOUND TRANSPORT layer - supports port and protocol conditions
            _logger.LogInformation("[DNS BLOCK] Registering on OUTBOUND_TRANSPORT_V4 layer with weight {Weight}", weight);
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_BLOCK, conditionsPtr, (uint)conditions.Length, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionsPtr);
        }
    }

    /// <summary>
    /// Block ALL DNS traffic (port 53) - IPv6
    /// Uses OUTBOUND TRANSPORT layer to catch all DNS packets (including reused socket connections)
    /// Conditions: UDP protocol AND remote port 53
    /// </summary>
    public ulong AddBlockAllDnsV6(string name, ulong weight = 165)
    {
        EnsureOpen();

        var conditions = new FWPM_FILTER_CONDITION0[2];

        // Condition 1: Protocol = UDP (most DNS)
        conditions[0] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_PROTOCOL,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT8,
                value = new FWP_VALUE0_UNION { uint8 = WfpConstants.IPPROTO_UDP }
            }
        };

        // Condition 2: Remote port = 53
        conditions[1] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_PORT,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT16,
                value = new FWP_VALUE0_UNION { uint16 = 53 }
            }
        };

        int size = Marshal.SizeOf<FWPM_FILTER_CONDITION0>();
        IntPtr conditionsPtr = Marshal.AllocHGlobal(size * conditions.Length);

        try
        {
            for (int i = 0; i < conditions.Length; i++)
            {
                IntPtr ptr = IntPtr.Add(conditionsPtr, i * size);
                Marshal.StructureToPtr(conditions[i], ptr, false);
            }

            // Use OUTBOUND TRANSPORT layer - supports port and protocol conditions
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V6,
                WfpConstants.FWP_ACTION_BLOCK, conditionsPtr, (uint)conditions.Length, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionsPtr);
        }
    }

    /// <summary>
    /// Permit DNS traffic (port 53) ONLY on the VPN tunnel interface - IPv4
    /// Uses IP PACKET layer to ensure all DNS packets (including reused sockets) go through tunnel
    /// Higher weight than AddBlockAllDns, so DNS through tunnel is allowed
    /// Conditions: UDP protocol AND Remote port = 53 AND Interface = tunnel
    /// </summary>
    public ulong AddPermitDnsOnTunnelInterface(string name, uint tunnelInterfaceIndex, ulong weight = 170)
    {
        EnsureOpen();

        _logger.LogInformation("[DNS OUTBOUND] Creating permit filter for tunnel interface {InterfaceIndex}", tunnelInterfaceIndex);

        var conditions = new FWPM_FILTER_CONDITION0[3];

        // Condition 1: Protocol = UDP
        conditions[0] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_PROTOCOL,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT8,
                value = new FWP_VALUE0_UNION { uint8 = WfpConstants.IPPROTO_UDP }
            }
        };

        // Condition 2: Remote port = 53 (DNS)
        conditions[1] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_PORT,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT16,
                value = new FWP_VALUE0_UNION { uint16 = 53 }
            }
        };

        // Condition 3: Interface index = tunnel (permit only on tunnel)
        conditions[2] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_INTERFACE_INDEX,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = tunnelInterfaceIndex }
            }
        };

        _logger.LogInformation("[DNS OUTBOUND] Conditions:");
        _logger.LogInformation("  [1] IP_PROTOCOL = UDP (17)");
        _logger.LogInformation("  [2] IP_REMOTE_PORT = 53");
        _logger.LogInformation("  [3] INTERFACE_INDEX = {Index}", tunnelInterfaceIndex);

        int size = Marshal.SizeOf<FWPM_FILTER_CONDITION0>();
        IntPtr conditionsPtr = Marshal.AllocHGlobal(size * conditions.Length);

        try
        {
            for (int i = 0; i < conditions.Length; i++)
            {
                IntPtr ptr = IntPtr.Add(conditionsPtr, i * size);
                Marshal.StructureToPtr(conditions[i], ptr, false);
            }

            // Use OUTBOUND TRANSPORT layer - supports port and protocol conditions
            _logger.LogInformation("[DNS OUTBOUND] Registering on OUTBOUND_TRANSPORT_V4 layer with weight {Weight}", weight);
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionsPtr, (uint)conditions.Length, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionsPtr);
        }
    }

    /// <summary>
    /// Permit INBOUND traffic on the VPN tunnel interface - IPv4
    /// Uses ALE AUTH RECV ACCEPT layer to authorize incoming traffic on tunnel
    /// Conditions: Interface = tunnel only (permits all inbound on tunnel interface)
    /// </summary>
    public ulong AddPermitDnsInboundOnTunnelInterface(string name, uint tunnelInterfaceIndex, ulong weight = 170)
    {
        EnsureOpen();

        _logger.LogInformation("[DNS INBOUND] Creating permit filter for tunnel interface {InterfaceIndex}", tunnelInterfaceIndex);

        var conditions = new FWPM_FILTER_CONDITION0[1];

        // Condition 1: Interface index = tunnel (permit only on tunnel)
        conditions[0] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_INTERFACE_INDEX,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = tunnelInterfaceIndex }
            }
        };

        _logger.LogInformation("[DNS INBOUND] Conditions:");
        _logger.LogInformation("  [1] INTERFACE_INDEX = {Index} (tunnel only)", tunnelInterfaceIndex);
        _logger.LogInformation("[DNS INBOUND] Strategy: Permit all inbound traffic on tunnel (responses from DNS will match)");

        int size = Marshal.SizeOf<FWPM_FILTER_CONDITION0>();
        IntPtr conditionsPtr = Marshal.AllocHGlobal(size * conditions.Length);

        try
        {
            for (int i = 0; i < conditions.Length; i++)
            {
                IntPtr ptr = IntPtr.Add(conditionsPtr, i * size);
                Marshal.StructureToPtr(conditions[i], ptr, false);
            }

            // Use ALE AUTH RECV ACCEPT layer - can match any inbound traffic based on interface
            _logger.LogInformation("[DNS INBOUND] Registering on ALE_AUTH_RECV_ACCEPT_V4 layer with weight {Weight}", weight);
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionsPtr, (uint)conditions.Length, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionsPtr);
        }
    }

    /// <summary>
    /// Permit DNS traffic (port 53) ONLY on the VPN tunnel interface - IPv6
    /// Uses IP PACKET layer to ensure all DNS packets (including reused sockets) go through tunnel
    /// Higher weight than AddBlockAllDnsV6, so DNS through tunnel is allowed
    /// Conditions: UDP protocol AND Remote port = 53 AND Interface = tunnel
    /// </summary>
    public ulong AddPermitDnsOnTunnelInterfaceV6(string name, uint tunnelInterfaceIndex, ulong weight = 170)
    {
        EnsureOpen();

        var conditions = new FWPM_FILTER_CONDITION0[3];

        // Condition 1: Protocol = UDP
        conditions[0] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_PROTOCOL,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT8,
                value = new FWP_VALUE0_UNION { uint8 = WfpConstants.IPPROTO_UDP }
            }
        };

        // Condition 2: Remote port = 53 (DNS)
        conditions[1] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_PORT,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT16,
                value = new FWP_VALUE0_UNION { uint16 = 53 }
            }
        };

        // Condition 3: Interface index = tunnel (permit only on tunnel)
        conditions[2] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_INTERFACE_INDEX,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = tunnelInterfaceIndex }
            }
        };

        int size = Marshal.SizeOf<FWPM_FILTER_CONDITION0>();
        IntPtr conditionsPtr = Marshal.AllocHGlobal(size * conditions.Length);

        try
        {
            for (int i = 0; i < conditions.Length; i++)
            {
                IntPtr ptr = IntPtr.Add(conditionsPtr, i * size);
                Marshal.StructureToPtr(conditions[i], ptr, false);
            }

            // Use OUTBOUND TRANSPORT layer - supports port and protocol conditions
            // IPPACKET layer doesn't support port matching for IPv6
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionsPtr, (uint)conditions.Length, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionsPtr);
        }
    }

    /// <summary>
    /// Add a permit filter for LAN traffic (private networks)
    /// Returns list of filter IDs for all LAN subnets
    /// </summary>
    public List<ulong> AddPermitLanFilters(string namePrefix, ulong weight = 100)
    {
        EnsureOpen();
        var filterIds = new List<ulong>();

        // Private network subnets (RFC 1918 + link-local) using CIDR notation
        // WFP expects host byte order: 192.168.0.0 = 0xC0A80000 = (192<<24)|(168<<16)|(0<<8)|0
        var lanSubnets = new[]
        {
            (addr: 0x0A000000u, mask: 0xFF000000u, name: "10.0.0.0/8"),      // 10.0.0.0/8
            (addr: 0xAC100000u, mask: 0xFFF00000u, name: "172.16.0.0/12"),   // 172.16.0.0/12
            (addr: 0xC0A80000u, mask: 0xFFFF0000u, name: "192.168.0.0/16"),  // 192.168.0.0/16
            (addr: 0xA9FE0000u, mask: 0xFFFF0000u, name: "169.254.0.0/16"),  // 169.254.0.0/16 (link-local)
        };

        foreach (var (addr, mask, name) in lanSubnets)
        {
            try
            {
                // Use IP PACKET layer with range matching to permit both new and established LAN connections
                var id = AddSubnetFilterIpPacket($"{namePrefix} {name}",
                    WfpConstants.FWP_ACTION_PERMIT, addr, mask, weight);
                filterIds.Add(id);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to add LAN filter for subnet {Name}", name);
            }
        }

        return filterIds;
    }

    /// <summary>
    /// Add a permit filter for VPN tunnel interface traffic (both inbound and outbound)
    /// Must permit at BOTH OUTBOUND and INBOUND layers on IPPACKET and TRANSPORT
    /// Inbound permits are critical for receiving responses to HTTP/HTTPS/TCP requests
    /// </summary>
    public ulong AddPermitTunnelInterfaceFilter(string name, uint interfaceIndex, ulong weight = 100)
    {
        EnsureOpen();

        // Create condition for interface index
        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_INTERFACE_INDEX,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = interfaceIndex }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // OUTBOUND permits
            // Permit at IPPACKET layer (for raw IP traffic)
            var ipPacketId = AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            // Also permit at TRANSPORT layer (for TCP/UDP traffic)
            _logger.LogInformation("[Tunnel Interface] Adding OUTBOUND TRANSPORT layer permit for interface {Index}", interfaceIndex);
            AddFilterInternal($"{name} (Outbound Transport)", WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            // INBOUND permits - CRITICAL for responses
            // Permit inbound at IPPACKET layer (for response packets)
            _logger.LogInformation("[Tunnel Interface] Adding INBOUND IPPACKET layer permit for interface {Index}", interfaceIndex);
            AddFilterInternal($"{name} (Inbound IPPacket)", WfpGuids.FWPM_LAYER_INBOUND_IPPACKET_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            // Permit inbound at TRANSPORT layer (for TCP/UDP responses)
            _logger.LogInformation("[Tunnel Interface] Adding INBOUND TRANSPORT layer permit for interface {Index}", interfaceIndex);
            AddFilterInternal($"{name} (Inbound Transport)", WfpGuids.FWPM_LAYER_INBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            return ipPacketId;
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
        }
    }

    /// <summary>
    /// Add permit filters for an interface (IPv4) and return ALL filter IDs.
    /// Same layers as AddPermitTunnelInterfaceFilter but returns every ID for tracked cleanup.
    /// Used for physical interface permits that must be individually removable.
    /// </summary>
    public List<ulong> AddPermitInterfaceFilters(string name, uint interfaceIndex, ulong weight = 100)
    {
        EnsureOpen();

        var filterIds = new List<ulong>();

        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_INTERFACE_INDEX,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = interfaceIndex }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            filterIds.Add(AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));

            filterIds.Add(AddFilterInternal($"{name} (Outbound Transport)", WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));

            filterIds.Add(AddFilterInternal($"{name} (Inbound IPPacket)", WfpGuids.FWPM_LAYER_INBOUND_IPPACKET_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));

            filterIds.Add(AddFilterInternal($"{name} (Inbound Transport)", WfpGuids.FWPM_LAYER_INBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));

            return filterIds;
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
        }
    }

    /// <summary>
    /// Add a permit filter for VPN tunnel interface traffic (IPv6)
    /// Must permit at BOTH OUTBOUND and INBOUND layers on IPPACKET and TRANSPORT
    /// </summary>
    public ulong AddPermitTunnelInterfaceFilterV6(string name, uint interfaceIndex, ulong weight = 100)
    {
        EnsureOpen();

        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_INTERFACE_INDEX,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = interfaceIndex }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // OUTBOUND permits
            // Permit at IPPACKET layer
            var ipPacketId = AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            // Also permit at TRANSPORT layer
            AddFilterInternal($"{name} (Outbound Transport)", WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            // INBOUND permits - CRITICAL for responses
            // Permit inbound at IPPACKET layer
            AddFilterInternal($"{name} (Inbound IPPacket)", WfpGuids.FWPM_LAYER_INBOUND_IPPACKET_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            // Permit inbound at TRANSPORT layer
            AddFilterInternal($"{name} (Inbound Transport)", WfpGuids.FWPM_LAYER_INBOUND_TRANSPORT_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight);

            // ALE layer permits — required for split-tunneled apps on physical interface.
            // Without these, kill-switch BLOCK filters on ALE layers block IPv6 traffic
            // even though IPPACKET/TRANSPORT layers have PERMIT.
            // CLEAR_ACTION_RIGHT prevents lower-weight sublayers (Windows Firewall)
            // from overriding our PERMIT with their BLOCK filters.
            AddFilterInternal($"{name} (ALE Auth Connect)", WfpGuids.FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight, clearActionRight: true);

            // ALE_AUTH_RECV_ACCEPT: Use NO conditions (blanket PERMIT) because
            // INTERFACE_INDEX is not reliably resolved at this layer for IPv6 responses.
            // CLEAR_ACTION_RIGHT overrides external BLOCKs (e.g., Windows Firewall).
            AddFilterInternal($"{name} (ALE Auth Recv Accept)", WfpGuids.FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
                WfpConstants.FWP_ACTION_PERMIT, IntPtr.Zero, 0, weight, clearActionRight: true);

            return ipPacketId;
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
        }
    }

    /// <summary>
    /// Add permit filter for VPN server with specific protocol and port
    /// </summary>
    public ulong AddPermitVpnServerFilter(string name, string ipAddress, ushort port, bool isTcp, ulong weight = 100)
    {
        EnsureOpen();

        //var ip = IPAddress.Parse(ipAddress);
        //var ipBytes = ip.GetAddressBytes();
        //var ipUint = BitConverter.ToUInt32(ipBytes, 0);
        //uint ipNetworkOrder = (uint)IPAddress.HostToNetworkOrder((int)ipUint);
        //uint ipHostOrder = ipUint;

        // Convert IP address to UINT32
        if (!IPAddress.TryParse(ipAddress, out var ip))
            throw new ArgumentException("Invalid IP address", nameof(ipAddress));

        // WFP OUTBOUND_TRANSPORT layer expects host byte order (like loopback filter)
        // GetAddressBytes() returns network byte order [a,b,c,d], we need host byte order
        // For IP 108.61.75.180: network=[108,61,75,180], host order uint32=0x6C3D4BB4
        byte[] ipBytes = ip.GetAddressBytes();
        uint ipUint = ((uint)ipBytes[0] << 24) | ((uint)ipBytes[1] << 16) | ((uint)ipBytes[2] << 8) | ipBytes[3];

        _logger.LogInformation("[VPN Server] IP {Ip} -> Host byte order: 0x{Uint:X8}", ipAddress, ipUint);

        // Create conditions array: IP + Protocol + Port
        var conditions = new FWPM_FILTER_CONDITION0[3];

        // Condition 1: Remote IP address
        conditions[0] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = ipUint }
            }
        };

        // Condition 2: Protocol (TCP or UDP)
        conditions[1] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_PROTOCOL,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT8,
                value = new FWP_VALUE0_UNION { uint8 = isTcp ? WfpConstants.IPPROTO_TCP : WfpConstants.IPPROTO_UDP }
            }
        };

        // Condition 3: Remote port
        conditions[2] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_PORT,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT16,
                value = new FWP_VALUE0_UNION { uint16 = port }
            }
        };

        // Marshal condiitons array
        int size = Marshal.SizeOf<FWPM_FILTER_CONDITION0>();
        IntPtr conditionsPtr = Marshal.AllocHGlobal(size * conditions.Length);

        try
        {
            for (int i = 0; i < conditions.Length; i++)
            {
                IntPtr ptr = IntPtr.Add(conditionsPtr, i * size);
                Marshal.StructureToPtr(conditions[i], ptr, false);
            }

            // Register at OUTBOUND_TRANSPORT layer (for TCP/UDP with port matching)
            var transportId = AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionsPtr, (uint)conditions.Length, weight);

            // Also need to permit at OUTBOUND_IPPACKET layer since block-all exists there too
            // But IPPACKET layer doesn't support port matching, so create IP-only filter
            // Create IP-only condition for IPPACKET layer
            var ipOnlyCondition = new FWPM_FILTER_CONDITION0
            {
                fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
                matchType = WfpConstants.FWP_MATCH_EQUAL,
                conditionValue = new FWP_CONDITION_VALUE0
                {
                    type = WfpConstants.FWP_UINT32,
                    value = new FWP_VALUE0_UNION { uint32 = ipUint }
                }
            };

            var ipOnlyPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
            Marshal.StructureToPtr(ipOnlyCondition, ipOnlyPtr, false);

            try
            {
                _logger.LogInformation("[VPN Server] Also adding IPPACKET layer permit for {Ip}", ipAddress);
                AddFilterInternal($"{name} (IPPacket)", WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4,
                    WfpConstants.FWP_ACTION_PERMIT, ipOnlyPtr, 1, weight);
            }
            finally
            {
                Marshal.FreeHGlobal(ipOnlyPtr);
            }

            return transportId;
        }
        finally
        {
            Marshal.FreeHGlobal(conditionsPtr);
        }
    }

    /// <summary>
    /// Add permit filter for INBOUND traffic from VPN server (for handshake responses)
    /// Uses INBOUND_TRANSPORT layer to permit incoming UDP from VPN server
    /// </summary>
    public ulong AddPermitVpnServerInboundFilter(string name, string ipAddress, ushort port, bool isTcp, ulong weight = 100)
    {
        EnsureOpen();

        if (!IPAddress.TryParse(ipAddress, out var ip))
            throw new ArgumentException("Invalid IP address", nameof(ipAddress));

        // WFP INBOUND_TRANSPORT layer expects host byte order
        byte[] ipBytes = ip.GetAddressBytes();
        uint ipUint = ((uint)ipBytes[0] << 24) | ((uint)ipBytes[1] << 16) | ((uint)ipBytes[2] << 8) | ipBytes[3];

        _logger.LogInformation("[VPN Server Inbound] IP {Ip} -> Host byte order: 0x{Uint:X8}", ipAddress, ipUint);

        // Match on remote IP (VPN server) and protocol
        var conditions = new FWPM_FILTER_CONDITION0[2];

        // Condition 1: Remote IP address (VPN server)
        conditions[0] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = ipUint }
            }
        };

        // Condition 2: Protocol (UDP for WireGuard)
        conditions[1] = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_PROTOCOL,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT8,
                value = new FWP_VALUE0_UNION { uint8 = isTcp ? WfpConstants.IPPROTO_TCP : WfpConstants.IPPROTO_UDP }
            }
        };

        int size = Marshal.SizeOf<FWPM_FILTER_CONDITION0>();
        IntPtr conditionsPtr = Marshal.AllocHGlobal(size * conditions.Length);

        try
        {
            for (int i = 0; i < conditions.Length; i++)
            {
                IntPtr ptr = IntPtr.Add(conditionsPtr, i * size);
                Marshal.StructureToPtr(conditions[i], ptr, false);
            }

            // Use INBOUND_TRANSPORT layer for incoming packets
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_INBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionsPtr, (uint)conditions.Length, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionsPtr);
        }
    }

    private ulong AddRemotePortFilter(string name, uint action, ushort remotePort, ulong weight)
    {
        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_PORT,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT16,
                value = new FWP_VALUE0_UNION { uint16 = remotePort }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // Use transport layer for port filtering
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4,
                action, conditionPtr, 1, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
        }
    }

    private ulong AddSubnetFilter(string name, uint action, uint addr, uint mask, ulong weight)
    {
        // Create FWP_V4_ADDR_AND_MASK structure for subnet matching
        var addrAndMask = new FWP_V4_ADDR_AND_MASK
        {
            addr = addr,
            mask = mask
        };

        var addrMaskPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWP_V4_ADDR_AND_MASK>());
        Marshal.StructureToPtr(addrAndMask, addrMaskPtr, false);

        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_V4_ADDR_MASK,
                value = new FWP_VALUE0_UNION { ptr = addrMaskPtr }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // Use ALE layer which supports FWP_V4_ADDR_MASK type for subnet matching
            // OUTBOUND_IPPACKET layer doesn't support this type (FWP_E_TYPE_MISMATCH)
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                action, conditionPtr, 1, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
            Marshal.FreeHGlobal(addrMaskPtr);
        }
    }

    /// <summary>
    /// Add subnet filter at IP PACKET layer using range matching
    /// IP PACKET layer doesn't support FWP_V4_ADDR_MASK, so we use range matching instead
    /// This ensures both new AND established connections are allowed (unlike ALE layer)
    /// </summary>
    private ulong AddSubnetFilterIpPacket(string name, uint action, uint subnetAddr, uint subnetMask, ulong weight)
    {
        EnsureOpen();

        // Calculate range from subnet and mask
        // For 192.168.0.0/16: start=192.168.0.0, end=192.168.255.255
        uint startIp = subnetAddr;
        uint endIp = subnetAddr | (~subnetMask);

        // Create range structure
        var range = new FWP_RANGE0
        {
            valueLow = new FWP_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = startIp }
            },
            valueHigh = new FWP_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = endIp }
            }
        };

        var rangePtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWP_RANGE0>());
        Marshal.StructureToPtr(range, rangePtr, false);

        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_RANGE,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_RANGE,
                value = new FWP_VALUE0_UNION { rangeValue = rangePtr }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4,
                action, conditionPtr, 1, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
            Marshal.FreeHGlobal(rangePtr);
        }
    }

    private ulong AddIpRangeFilter(string name, uint action, uint startIp, uint endIp, ulong weight)
    {
        // Convert to network byte order
        uint startNetworkOrder = (uint)IPAddress.HostToNetworkOrder((int)startIp);
        uint endNetworkOrder = (uint)IPAddress.HostToNetworkOrder((int)endIp);

        // Create range structure
        var range = new FWP_RANGE0
        {
            valueLow = new FWP_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = startNetworkOrder }
            },
            valueHigh = new FWP_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = endNetworkOrder }
            }
        };

        var rangePtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWP_RANGE0>());
        Marshal.StructureToPtr(range, rangePtr, false);

        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_RANGE,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_RANGE,
                value = new FWP_VALUE0_UNION { rangeValue = rangePtr }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4,
                action, conditionPtr, 1, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
            Marshal.FreeHGlobal(rangePtr);
        }
    }

    private static string FormatIpRange(uint start, uint end)
    {
        return $"{FormatIp(start)}-{FormatIp(end)}";
    }

    private static string FormatIp(uint ip)
    {
        return $"{(ip >> 24) & 0xFF}.{(ip >> 16) & 0xFF}.{(ip >> 8) & 0xFF}.{ip & 0xFF}";
    }

    /// <summary>
    /// Add WFP PERMIT filters for a specific remote IPv4 address/CIDR.
    /// Creates filters at OUTBOUND_IPPACKET, OUTBOUND_TRANSPORT, INBOUND_IPPACKET, and INBOUND_TRANSPORT layers.
    /// Used by split tunneling to allow excluded IPs to bypass the kill switch.
    /// </summary>
    /// <returns>List of created filter IDs</returns>
    public List<ulong> AddPermitRemoteIpv4Filter(string name, string ipAddress, int prefixLen, ulong weight = 150)
    {
        EnsureOpen();
        var filterIds = new List<ulong>();

        if (!IPAddress.TryParse(ipAddress, out var ip))
            throw new ArgumentException($"Invalid IPv4 address: {ipAddress}");

        // Convert to host byte order uint32
        byte[] ipBytes = ip.GetAddressBytes();
        uint ipUint = ((uint)ipBytes[0] << 24) | ((uint)ipBytes[1] << 16) | ((uint)ipBytes[2] << 8) | ipBytes[3];

        // Compute subnet mask from prefix length
        uint mask = prefixLen == 0 ? 0 : ~((1u << (32 - prefixLen)) - 1);

        _logger.LogInformation("[SplitTunnel IP] Adding IPv4 permit: {IP}/{Prefix} (host order: 0x{Uint:X8}, mask: 0x{Mask:X8})",
            ipAddress, prefixLen, ipUint, mask);

        IntPtr conditionPtr;
        IntPtr v4AddrMaskPtr = IntPtr.Zero;

        if (prefixLen == 32)
        {
            // Single IP — use FWP_UINT32 EQUAL match
            var condition = new FWPM_FILTER_CONDITION0
            {
                fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
                matchType = WfpConstants.FWP_MATCH_EQUAL,
                conditionValue = new FWP_CONDITION_VALUE0
                {
                    type = WfpConstants.FWP_UINT32,
                    value = new FWP_VALUE0_UNION { uint32 = ipUint }
                }
            };
            conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
            Marshal.StructureToPtr(condition, conditionPtr, false);
        }
        else
        {
            // Subnet — use FWP_V4_ADDR_MASK
            // FWP_V4_ADDR_AND_MASK is 8 bytes: 4-byte addr + 4-byte mask, both in host byte order
            v4AddrMaskPtr = Marshal.AllocHGlobal(8);
            Marshal.WriteInt32(v4AddrMaskPtr, (int)(ipUint & mask)); // network address
            Marshal.WriteInt32(v4AddrMaskPtr + 4, (int)mask);       // subnet mask

            var condition = new FWPM_FILTER_CONDITION0
            {
                fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
                matchType = WfpConstants.FWP_MATCH_EQUAL,
                conditionValue = new FWP_CONDITION_VALUE0
                {
                    type = WfpConstants.FWP_V4_ADDR_MASK,
                    value = new FWP_VALUE0_UNION { ptr = v4AddrMaskPtr }
                }
            };
            conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
            Marshal.StructureToPtr(condition, conditionPtr, false);
        }

        try
        {
            // Outbound permits
            filterIds.Add(AddFilterInternal($"{name} (Out IPPacket)", WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));
            filterIds.Add(AddFilterInternal($"{name} (Out Transport)", WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));

            // Inbound permits (for responses)
            filterIds.Add(AddFilterInternal($"{name} (In IPPacket)", WfpGuids.FWPM_LAYER_INBOUND_IPPACKET_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));
            filterIds.Add(AddFilterInternal($"{name} (In Transport)", WfpGuids.FWPM_LAYER_INBOUND_TRANSPORT_V4,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
            if (v4AddrMaskPtr != IntPtr.Zero) Marshal.FreeHGlobal(v4AddrMaskPtr);
        }

        return filterIds;
    }

    /// <summary>
    /// Add WFP PERMIT filters for a specific remote IPv6 address/CIDR.
    /// Creates filters at OUTBOUND_IPPACKET, OUTBOUND_TRANSPORT, INBOUND_IPPACKET, and INBOUND_TRANSPORT layers.
    /// Used by split tunneling to allow excluded IPs to bypass the kill switch.
    /// </summary>
    /// <returns>List of created filter IDs</returns>
    public List<ulong> AddPermitRemoteIpv6Filter(string name, string ipAddress, int prefixLen, ulong weight = 150)
    {
        EnsureOpen();
        var filterIds = new List<ulong>();

        if (!IPAddress.TryParse(ipAddress, out var ip))
            throw new ArgumentException($"Invalid IPv6 address: {ipAddress}");

        _logger.LogInformation("[SplitTunnel IP] Adding IPv6 permit: {IP}/{Prefix}", ipAddress, prefixLen);

        // FWP_V6_ADDR_MASK: 16-byte address + 1-byte prefix length = 17 bytes
        byte[] addrBytes = ip.GetAddressBytes(); // 16 bytes
        byte[] v6Data = new byte[17];
        Array.Copy(addrBytes, v6Data, 16);
        v6Data[16] = (byte)prefixLen;

        IntPtr v6Ptr = Marshal.AllocHGlobal(17);
        Marshal.Copy(v6Data, 0, v6Ptr, 17);

        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_V6_ADDR_MASK,
                value = new FWP_VALUE0_UNION { ptr = v6Ptr }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // Outbound permits
            filterIds.Add(AddFilterInternal($"{name} (Out IPPacket)", WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));
            filterIds.Add(AddFilterInternal($"{name} (Out Transport)", WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));

            // Inbound permits (for responses)
            filterIds.Add(AddFilterInternal($"{name} (In IPPacket)", WfpGuids.FWPM_LAYER_INBOUND_IPPACKET_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));
            filterIds.Add(AddFilterInternal($"{name} (In Transport)", WfpGuids.FWPM_LAYER_INBOUND_TRANSPORT_V6,
                WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, weight));
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
            Marshal.FreeHGlobal(v6Ptr);
        }

        return filterIds;
    }

    /// <summary>
    /// Remove a filter by ID
    /// </summary>
    public void RemoveFilter(ulong filterId)
    {
        if (!_isOpen) return;

        var result = WfpNative.FwpmFilterDeleteById0(_engineHandle, filterId);
        if (result != 0 && result != 0x80320008) // FWP_E_FILTER_NOT_FOUND
        {
            _logger.LogWarning("FwpmFilterDeleteById0 failed for filter {Id}: {Error}", filterId, result);
        }

        _filterIds.Remove(filterId);
    }

    /// <summary>
    /// Remove all filters added by this engine
    /// </summary>
    public void RemoveAllFilters()
    {
        foreach (var id in _filterIds.ToList())
        {
            RemoveFilter(id);
        }
    }

    /// <summary>
    /// Emergency cleanup: Close and reopen WFP engine to force removal of all dynamic filters
    /// Use this when normal filter removal fails to restore network access
    /// </summary>
    public void EmergencyCleanup()
    {
        _logger.LogWarning("Performing emergency WFP cleanup - removing persistent filters, then closing and reopening engine");
        try
        {
            // Remove persistent filters FIRST (before closing the engine handle we need for enumeration)
            try { RemovePersistentBlockAllFilters(); }
            catch (Exception ex) { _logger.LogError(ex, "Emergency: failed to remove persistent filters"); }

            // Close persistent session if open
            try { ClosePersistentSession(); }
            catch (Exception ex) { _logger.LogError(ex, "Emergency: failed to close persistent session"); }

            Close();  // Closes engine, dynamic filters auto-remove
            System.Threading.Thread.Sleep(500);  // Give WFP time to clean up
            Open();   // Reopen for future use
            _logger.LogInformation("Emergency cleanup completed successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Emergency cleanup failed - manual intervention may be required");
        }
    }

    /// <summary>
    /// Add permit filter for VPN server IP address
    /// Uses IP packet layer with simple IP address matching
    /// </summary>
    private ulong AddVpnServerFilter(string name, uint action, uint ipAddress, ulong weight)
    {
        // Convert IP address to network byte order (little-endian)
        uint ipNetworkOrder = (uint)IPAddress.HostToNetworkOrder((int)ipAddress);

        // Create single condition: Remote IP address only
        // (Protocol and port conditions cause FWP_E_INVALID_PARAMETER at this layer)
        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION { uint32 = ipNetworkOrder }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // Use OUTBOUND_IPPACKET_V4 layer with single condition
            return AddFilterInternal(
                name,
                WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4,
                action,
                conditionPtr,
                1,  // Single condition
                weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
        }
    }


    private ulong AddLoopbackInterfaceTypeFilter(string name, uint action, ulong weight)
    {
        // Create condition for loopback interface type
        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_INTERFACE_TYPE,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT32,
                value = new FWP_VALUE0_UNION
                {
                    uint32 = WfpConstants.IF_TYPE_SOFTWARE_LOOPBACK
                }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // Use ALE layer where interface type matching is supported
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_ALE_AUTH_CONNECT_V4, action, conditionPtr, 1, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
        }
    }

    private ulong AddUdpPortFilter(string name, uint action, ushort localPort, ushort remotePort, ulong weight)
    {
        // Create single condition for local port (DHCP client port 68)
        // DHCP traffic outbound on local port 68 is distinct enough for the kill switch
        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_LOCAL_PORT,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT16,
                value = new FWP_VALUE0_UNION { uint16 = localPort }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            // OUTBOUND_TRANSPORT layer: permit packets from local port 68 (DHCP client)
            // IPPACKET layer doesn't support IP_LOCAL_PORT condition
            return AddFilterInternal(name, WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4, action, conditionPtr, 1, weight);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
        }
    }

    private ulong AddBlockAllFilterInternal(string name, Guid layer, ulong weight)
    {
        // No conditions = matches all traffic
        return AddFilterInternal(name, layer, WfpConstants.FWP_ACTION_BLOCK, IntPtr.Zero, 0, weight);
    }

    private ulong AddFilterInternal(string name, Guid layer, uint action, IntPtr conditions, uint conditionCount, ulong weight, bool clearActionRight = false)
    {
        // FWP_UINT64 requires a pointer to the uint64 value, not the value itself
        IntPtr weightPtr = Marshal.AllocHGlobal(sizeof(ulong));
        try
        {
            Marshal.WriteInt64(weightPtr, (long)weight);

            var filter = new FWPM_FILTER0
            {
                filterKey = Guid.NewGuid(),
                displayData = new FWPM_DISPLAY_DATA0
                {
                    name = name,
                    description = $"WireDog Kill Switch - {name}"
                },
                // CLEAR_ACTION_RIGHT: when set on a PERMIT filter, prevents lower-weight
                // sublayers (like Windows Firewall) from overriding with BLOCK
                flags = (clearActionRight && action == WfpConstants.FWP_ACTION_PERMIT)
                    ? WfpConstants.FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT : 0,
                providerKey = IntPtr.Zero, // No provider association needed for fully dynamic setup
                providerData = default,
                layerKey = layer,
                subLayerKey = WfpGuids.WIREDOG_SUBLAYER,
                weight = new FWP_VALUE0
                {
                    type = WfpConstants.FWP_UINT64,
                    value = new FWP_VALUE0_UNION { ptr = weightPtr }
                },
                numFilterConditions = conditionCount,
                filterCondition = conditions,
                action = new FWPM_ACTION0 { type = action, filterType = Guid.Empty },
                providerContextKey = Guid.Empty,
                reserved = IntPtr.Zero,
                filterId = 0,
                effectiveWeight = default
            };

            _logger.LogInformation("[WFP] Attempting to register filter: '{Name}'", name);
            _logger.LogInformation("  Layer: {LayerGuid}", layer);
            _logger.LogInformation("  Action: {Action}", action == WfpConstants.FWP_ACTION_PERMIT ? "PERMIT" : "BLOCK");
            _logger.LogInformation("  Weight: {Weight}", weight);
            _logger.LogInformation("  Condition count: {ConditionCount}", conditionCount);

            var result = WfpNative.FwpmFilterAdd0(_engineHandle, ref filter, IntPtr.Zero, out var filterId);
            if (result != 0)
            {
                string errorDesc = GetErrorDescription(result);
                _logger.LogError("[WFP] FAILED to register filter '{Name}': error 0x{Error:X8} ({ErrorDesc})", name, result, errorDesc);
                throw new Win32Exception((int)result, $"FwpmFilterAdd0 failed for '{name}': error {result:X8}");
            }

            _filterIds.Add(filterId);
            _logger.LogInformation("[WFP] ✓ Successfully registered filter '{Name}' with ID {Id}", name, filterId);

            return filterId;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[WFP] Exception while registering filter '{Name}'", name);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(weightPtr);
        }
    }

    /// <summary>
    /// Dump DNS filter statistics for debugging
    /// Shows how many packets matched each DNS filter
    /// </summary>
    public void DumpDnsFilterStatistics(List<ulong> dnsFilterIds)
    {
        if (!_isOpen || dnsFilterIds == null || dnsFilterIds.Count == 0)
        {
            _logger.LogWarning("[STATS] Cannot dump statistics - engine not open or no filter IDs provided");
            return;
        }

        _logger.LogInformation("========================================");
        _logger.LogInformation("[DNS STATS] Filter Statistics Snapshot");
        _logger.LogInformation("========================================");

        try
        {
            // Create enumeration handle for all filters
            var result = WfpNative.FwpmFilterCreateEnumHandle0(_engineHandle, IntPtr.Zero, out IntPtr enumHandle);
            if (result != 0)
            {
                _logger.LogError("[STATS] Failed to create enum handle: 0x{Error:X8}", result);
                return;
            }

            try
            {
                const uint BATCH_SIZE = 100;
                uint totalFilters = 0;

                while (true)
                {
                    result = WfpNative.FwpmFilterEnum0(_engineHandle, enumHandle, BATCH_SIZE, out IntPtr entries, out uint numReturned);

                    if (result != 0)
                    {
                        _logger.LogError("[STATS] Filter enumeration failed: 0x{Error:X8}", result);
                        break;
                    }

                    if (numReturned == 0)
                        break;

                    try
                    {
                        // Parse filter entries (entries is an array of pointers to FWPM_FILTER0)
                        for (int i = 0; i < numReturned; i++)
                        {
                            IntPtr filterPtr = Marshal.ReadIntPtr(entries, i * IntPtr.Size);
                            var filter = Marshal.PtrToStructure<FWPM_FILTER0>(filterPtr);

                            // Check if this is one of our DNS filters
                            if (dnsFilterIds.Contains(filter.filterId))
                            {
                                string actionStr = filter.action.type == WfpConstants.FWP_ACTION_PERMIT ? "PERMIT" : "BLOCK";
                                _logger.LogInformation("[STATS] Filter ID {Id}:", filter.filterId);
                                _logger.LogInformation("  Name: {Name}", filter.displayData.name);
                                _logger.LogInformation("  Action: {Action}", actionStr);
                                _logger.LogInformation("  Weight: {Weight}", filter.weight.value.uint64);
                                _logger.LogInformation("  Conditions: {CondCount}", filter.numFilterConditions);
                            }

                            totalFilters++;
                        }

                        var entriesRef = entries;
                        WfpNative.FwpmFreeMemory0(ref entriesRef);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "[STATS] Error parsing filter entries");
                        var entriesRef = entries;
                        WfpNative.FwpmFreeMemory0(ref entriesRef);
                        break;
                    }
                }

                _logger.LogInformation("[STATS] Total filters enumerated: {Count}", totalFilters);
                _logger.LogInformation("========================================");
            }
            finally
            {
                WfpNative.FwpmFilterDestroyEnumHandle0(_engineHandle, enumHandle);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[STATS] Exception while dumping statistics");
        }
    }

    private void EnsureOpen()
    {
        if (!_isOpen)
        {
            throw new InvalidOperationException("WFP engine is not open");
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        ClosePersistentSession(); // Close persistent session (does NOT remove persistent filters)
        Close();
    }

    // ============ Persistent Session (Advanced Kill Switch) ============

    /// <summary>
    /// Open a non-dynamic WFP session for persistent filter management.
    /// Filters added via this session survive process exit. With FWPM_FILTER_FLAG_PERSISTENT, they survive reboot.
    /// </summary>
    public void OpenPersistentSession()
    {
        if (_isPersistentOpen) return;

        var session = new FWPM_SESSION0
        {
            displayData = new FWPM_DISPLAY_DATA0
            {
                name = "WireDog Persistent",
                description = "WireDog Advanced Kill Switch Persistent Session"
            },
            flags = 0, // NO FWPM_SESSION_FLAG_DYNAMIC - filters survive process exit
            txnWaitTimeoutInMSec = 5000
        };

        uint result = WfpNative.FwpmEngineOpen0(
            null,
            WfpConstants.RPC_C_AUTHN_DEFAULT,
            IntPtr.Zero,
            ref session,
            out _persistentEngineHandle);

        if (result != 0)
        {
            throw new Win32Exception((int)result, $"FwpmEngineOpen0 (persistent) failed: {result}");
        }

        _isPersistentOpen = true;
        _logger.LogInformation("Persistent WFP session opened (handle: {Handle})", _persistentEngineHandle);

        RegisterPersistentProviderAndSublayer();
    }

    /// <summary>
    /// Close the persistent WFP session. Persistent filters remain in BFE.
    /// </summary>
    public void ClosePersistentSession()
    {
        if (!_isPersistentOpen) return;

        _persistentFilterIds.Clear();

        if (_persistentEngineHandle != IntPtr.Zero)
        {
            WfpNative.FwpmEngineClose0(_persistentEngineHandle);
            _persistentEngineHandle = IntPtr.Zero;
        }

        _isPersistentOpen = false;
        _logger.LogInformation("Persistent WFP session closed (filters remain in BFE)");
    }

    /// <summary>
    /// Add persistent block-all filters: block IPv4/IPv6 at weight 10/50 plus essential permits.
    /// These filters survive process exit AND system reboot (FWPM_FILTER_FLAG_PERSISTENT).
    /// Must call OpenPersistentSession() first.
    /// </summary>
    public void AddPersistentBlockAllFilters()
    {
        if (!_isPersistentOpen)
            throw new InvalidOperationException("Persistent WFP session not open");

        _logger.LogInformation("[Persistent KS] Adding persistent block-all filters...");

        // --- Block all IPv4 (weight 10 - lowest, overridden by all dynamic permits) ---
        AddPersistentFilterInternal("Persistent Block All IPv4 (Transport)",
            WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4, WfpConstants.FWP_ACTION_BLOCK, IntPtr.Zero, 0, 10);
        AddPersistentFilterInternal("Persistent Block All IPv4 (IPPacket)",
            WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4, WfpConstants.FWP_ACTION_BLOCK, IntPtr.Zero, 0, 10);

        // --- Block all IPv6 (weight 50) ---
        AddPersistentFilterInternal("Persistent Block All IPv6 (Transport)",
            WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V6, WfpConstants.FWP_ACTION_BLOCK, IntPtr.Zero, 0, 50);
        AddPersistentFilterInternal("Persistent Block All IPv6 (IPPacket)",
            WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V6, WfpConstants.FWP_ACTION_BLOCK, IntPtr.Zero, 0, 50);

        // --- Permit loopback IPv4 127.0.0.0/8 (weight 200) ---
        AddPersistentLoopbackFilter();

        // --- Permit DHCP UDP local port 68 (weight 170) ---
        AddPersistentDhcpFilter();

        // --- Permit LAN subnets (weight 180) ---
        AddPersistentLanFilters();

        _logger.LogInformation("[Persistent KS] Persistent block-all filters added ({Count} total)", _persistentFilterIds.Count);
    }

    /// <summary>
    /// Remove all filters from the persistent sublayer (by enumerating BFE).
    /// Works even if the persistent engine handle is closed (uses dynamic session handle).
    /// </summary>
    public void RemovePersistentBlockAllFilters()
    {
        _logger.LogInformation("[Persistent KS] Removing persistent block-all filters from BFE...");

        // Use whichever handle is available
        var handle = _isPersistentOpen ? _persistentEngineHandle :
                     _isOpen ? _engineHandle : IntPtr.Zero;

        if (handle == IntPtr.Zero)
        {
            _logger.LogWarning("[Persistent KS] No WFP session available to remove persistent filters");
            return;
        }

        int removed = 0;
        try
        {
            var result = WfpNative.FwpmFilterCreateEnumHandle0(handle, IntPtr.Zero, out IntPtr enumHandle);
            if (result != 0)
            {
                _logger.LogWarning("[Persistent KS] Failed to create filter enum handle: 0x{Error:X8}", result);
                return;
            }

            var filtersToDelete = new List<ulong>();
            try
            {
                const uint BATCH_SIZE = 100;
                while (true)
                {
                    result = WfpNative.FwpmFilterEnum0(handle, enumHandle, BATCH_SIZE, out IntPtr entries, out uint numReturned);
                    if (result != 0 || numReturned == 0) break;

                    try
                    {
                        for (int i = 0; i < numReturned; i++)
                        {
                            IntPtr filterPtr = Marshal.ReadIntPtr(entries, i * IntPtr.Size);
                            var filter = Marshal.PtrToStructure<FWPM_FILTER0>(filterPtr);
                            if (filter.subLayerKey == WfpGuids.WIREDOG_PERSISTENT_SUBLAYER)
                                filtersToDelete.Add(filter.filterId);
                        }
                        var entriesRef = entries;
                        WfpNative.FwpmFreeMemory0(ref entriesRef);
                    }
                    catch { var entriesRef = entries; WfpNative.FwpmFreeMemory0(ref entriesRef); break; }
                }
            }
            finally
            {
                WfpNative.FwpmFilterDestroyEnumHandle0(handle, enumHandle);
            }

            foreach (var filterId in filtersToDelete)
            {
                result = WfpNative.FwpmFilterDeleteById0(handle, filterId);
                if (result == 0) removed++;
                else _logger.LogWarning("[Persistent KS] Failed to delete persistent filter {Id}: 0x{Error:X8}", filterId, result);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Persistent KS] Exception removing persistent filters");
        }

        _persistentFilterIds.Clear();
        _logger.LogInformation("[Persistent KS] Removed {Count} persistent filters from BFE", removed);
    }

    /// <summary>
    /// Check if our persistent block-all filters exist in BFE.
    /// Uses the dynamic session handle (no persistent session required).
    /// </summary>
    public bool ArePersistentFiltersActive()
    {
        if (!_isOpen) return false;

        try
        {
            var result = WfpNative.FwpmFilterCreateEnumHandle0(_engineHandle, IntPtr.Zero, out IntPtr enumHandle);
            if (result != 0) return false;

            bool found = false;
            try
            {
                const uint BATCH_SIZE = 100;
                while (!found)
                {
                    result = WfpNative.FwpmFilterEnum0(_engineHandle, enumHandle, BATCH_SIZE, out IntPtr entries, out uint numReturned);
                    if (result != 0 || numReturned == 0) break;

                    try
                    {
                        for (int i = 0; i < numReturned; i++)
                        {
                            IntPtr filterPtr = Marshal.ReadIntPtr(entries, i * IntPtr.Size);
                            var filter = Marshal.PtrToStructure<FWPM_FILTER0>(filterPtr);
                            if (filter.subLayerKey == WfpGuids.WIREDOG_PERSISTENT_SUBLAYER)
                            {
                                found = true;
                                break;
                            }
                        }
                        var entriesRef = entries;
                        WfpNative.FwpmFreeMemory0(ref entriesRef);
                    }
                    catch { var entriesRef = entries; WfpNative.FwpmFreeMemory0(ref entriesRef); break; }
                }
            }
            finally
            {
                WfpNative.FwpmFilterDestroyEnumHandle0(_engineHandle, enumHandle);
            }

            return found;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Persistent KS] Exception checking persistent filters");
            return false;
        }
    }

    private void RegisterPersistentProviderAndSublayer()
    {
        uint result = WfpNative.FwpmTransactionBegin0(_persistentEngineHandle, 0);
        if (result != 0)
        {
            _logger.LogError("[Persistent KS] FwpmTransactionBegin0 failed: 0x{Error:X8}", result);
            return;
        }

        try
        {
            // Add persistent provider
            var provider = new FWPM_PROVIDER0
            {
                providerKey = WfpGuids.WIREDOG_PERSISTENT_PROVIDER,
                displayData = new FWPM_DISPLAY_DATA0
                {
                    name = "WireDog Persistent",
                    description = "WireDog Advanced Kill Switch"
                },
                flags = WfpConstants.FWPM_PROVIDER_FLAG_PERSISTENT
            };

            result = WfpNative.FwpmProviderAdd0(_persistentEngineHandle, ref provider, IntPtr.Zero);
            if (result != 0 && result != 0x80320009) // FWP_E_ALREADY_EXISTS is OK
                _logger.LogWarning("[Persistent KS] FwpmProviderAdd0 failed: 0x{Error:X8}", result);

            // Add persistent sublayer
            var providerKeyPtr = Marshal.AllocHGlobal(Marshal.SizeOf<Guid>());
            Marshal.StructureToPtr(WfpGuids.WIREDOG_PERSISTENT_PROVIDER, providerKeyPtr, false);

            var sublayer = new FWPM_SUBLAYER0
            {
                subLayerKey = WfpGuids.WIREDOG_PERSISTENT_SUBLAYER,
                displayData = new FWPM_DISPLAY_DATA0
                {
                    name = "WireDog Persistent Kill Switch",
                    description = "WireDog Advanced Kill Switch - Persistent Sublayer"
                },
                flags = WfpConstants.FWPM_PROVIDER_FLAG_PERSISTENT, // 0x1 = persistent
                providerKey = providerKeyPtr,
                weight = 0xFFFE // Just below dynamic sublayer (0xFFFF)
            };

            result = WfpNative.FwpmSubLayerAdd0(_persistentEngineHandle, ref sublayer, IntPtr.Zero);
            Marshal.FreeHGlobal(providerKeyPtr);

            if (result != 0 && result != 0x80320009) // FWP_E_ALREADY_EXISTS is OK
                _logger.LogError("[Persistent KS] FwpmSubLayerAdd0 failed: 0x{Error:X8}", result);

            WfpNative.FwpmTransactionCommit0(_persistentEngineHandle);
            _logger.LogInformation("[Persistent KS] Persistent provider and sublayer registered");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Persistent KS] Exception registering persistent provider/sublayer");
            WfpNative.FwpmTransactionAbort0(_persistentEngineHandle);
            throw;
        }
    }

    private void AddPersistentLoopbackFilter()
    {
        uint startIp = 0x7F000000; // 127.0.0.0
        uint endIp = 0x7FFFFFFF;   // 127.255.255.255

        var range = new FWP_RANGE0
        {
            valueLow = new FWP_VALUE0 { type = WfpConstants.FWP_UINT32, value = new FWP_VALUE0_UNION { uint32 = startIp } },
            valueHigh = new FWP_VALUE0 { type = WfpConstants.FWP_UINT32, value = new FWP_VALUE0_UNION { uint32 = endIp } }
        };

        var rangePtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWP_RANGE0>());
        Marshal.StructureToPtr(range, rangePtr, false);

        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType = WfpConstants.FWP_MATCH_RANGE,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_RANGE,
                value = new FWP_VALUE0_UNION { rangeValue = rangePtr }
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            AddPersistentFilterInternal("Persistent Permit Loopback (IPPacket)",
                WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4, WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, 200);
            AddPersistentFilterInternal("Persistent Permit Loopback (Transport)",
                WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4, WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, 200);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
            Marshal.FreeHGlobal(rangePtr);
        }
    }

    private void AddPersistentDhcpFilter()
    {
        var condition = new FWPM_FILTER_CONDITION0
        {
            fieldKey = WfpGuids.FWPM_CONDITION_IP_LOCAL_PORT,
            matchType = WfpConstants.FWP_MATCH_EQUAL,
            conditionValue = new FWP_CONDITION_VALUE0
            {
                type = WfpConstants.FWP_UINT16,
                value = new FWP_VALUE0_UNION { uint16 = 68 } // DHCP client port
            }
        };

        var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
        Marshal.StructureToPtr(condition, conditionPtr, false);

        try
        {
            AddPersistentFilterInternal("Persistent Permit DHCP",
                WfpGuids.FWPM_LAYER_OUTBOUND_TRANSPORT_V4, WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, 170);
        }
        finally
        {
            Marshal.FreeHGlobal(conditionPtr);
        }
    }

    private void AddPersistentLanFilters()
    {
        var lanSubnets = new[]
        {
            (addr: 0x0A000000u, mask: 0xFF000000u, name: "10.0.0.0/8"),
            (addr: 0xAC100000u, mask: 0xFFF00000u, name: "172.16.0.0/12"),
            (addr: 0xC0A80000u, mask: 0xFFFF0000u, name: "192.168.0.0/16"),
            (addr: 0xA9FE0000u, mask: 0xFFFF0000u, name: "169.254.0.0/16"),
        };

        foreach (var (addr, mask, subnetName) in lanSubnets)
        {
            uint startIp = addr;
            uint endIp = addr | (~mask);

            var range = new FWP_RANGE0
            {
                valueLow = new FWP_VALUE0 { type = WfpConstants.FWP_UINT32, value = new FWP_VALUE0_UNION { uint32 = startIp } },
                valueHigh = new FWP_VALUE0 { type = WfpConstants.FWP_UINT32, value = new FWP_VALUE0_UNION { uint32 = endIp } }
            };

            var rangePtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWP_RANGE0>());
            Marshal.StructureToPtr(range, rangePtr, false);

            var condition = new FWPM_FILTER_CONDITION0
            {
                fieldKey = WfpGuids.FWPM_CONDITION_IP_REMOTE_ADDRESS,
                matchType = WfpConstants.FWP_MATCH_RANGE,
                conditionValue = new FWP_CONDITION_VALUE0
                {
                    type = WfpConstants.FWP_RANGE,
                    value = new FWP_VALUE0_UNION { rangeValue = rangePtr }
                }
            };

            var conditionPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FWPM_FILTER_CONDITION0>());
            Marshal.StructureToPtr(condition, conditionPtr, false);

            try
            {
                AddPersistentFilterInternal($"Persistent Permit LAN {subnetName}",
                    WfpGuids.FWPM_LAYER_OUTBOUND_IPPACKET_V4, WfpConstants.FWP_ACTION_PERMIT, conditionPtr, 1, 180);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Persistent KS] Failed to add LAN filter for {Subnet}", subnetName);
            }
            finally
            {
                Marshal.FreeHGlobal(conditionPtr);
                Marshal.FreeHGlobal(rangePtr);
            }
        }
    }

    private ulong AddPersistentFilterInternal(string name, Guid layer, uint action, IntPtr conditions, uint conditionCount, ulong weight)
    {
        IntPtr weightPtr = Marshal.AllocHGlobal(sizeof(ulong));
        try
        {
            Marshal.WriteInt64(weightPtr, (long)weight);

            var filter = new FWPM_FILTER0
            {
                filterKey = Guid.NewGuid(),
                displayData = new FWPM_DISPLAY_DATA0
                {
                    name = name,
                    description = $"WireDog Advanced Kill Switch - {name}"
                },
                flags = WfpConstants.FWPM_FILTER_FLAG_PERSISTENT, // KEY: survives reboot
                providerKey = IntPtr.Zero,
                providerData = default,
                layerKey = layer,
                subLayerKey = WfpGuids.WIREDOG_PERSISTENT_SUBLAYER,
                weight = new FWP_VALUE0
                {
                    type = WfpConstants.FWP_UINT64,
                    value = new FWP_VALUE0_UNION { ptr = weightPtr }
                },
                numFilterConditions = conditionCount,
                filterCondition = conditions,
                action = new FWPM_ACTION0 { type = action, filterType = Guid.Empty },
                providerContextKey = Guid.Empty,
                reserved = IntPtr.Zero,
                filterId = 0,
                effectiveWeight = default
            };

            var result = WfpNative.FwpmFilterAdd0(_persistentEngineHandle, ref filter, IntPtr.Zero, out var filterId);
            if (result != 0)
                throw new Win32Exception((int)result, $"FwpmFilterAdd0 (persistent) failed for '{name}': {result:X8}");

            _persistentFilterIds.Add(filterId);
            _logger.LogInformation("[Persistent KS] Added filter '{Name}' (ID: {Id})", name, filterId);
            return filterId;
        }
        finally
        {
            Marshal.FreeHGlobal(weightPtr);
        }
    }
}
