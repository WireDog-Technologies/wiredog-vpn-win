using System.Runtime.InteropServices;

namespace WireDog.Service.Wfp;

/// <summary>
/// P/Invoke declarations for Windows Filtering Platform (fwpuclnt.dll)
/// </summary>
public static unsafe class WfpNative
{
    private const string FWPUCLNT = "fwpuclnt.dll";

    // ============ Engine Functions ============

    [DllImport(FWPUCLNT, CharSet = CharSet.Unicode)]
    public static extern uint FwpmEngineOpen0(
        string? serverName,
        uint authnService,
        IntPtr authIdentity,
        ref FWPM_SESSION0 session,
        out IntPtr engineHandle);

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmEngineClose0(IntPtr engineHandle);

    // ============ Transaction Functions ============

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmTransactionBegin0(IntPtr engineHandle, uint flags);

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmTransactionCommit0(IntPtr engineHandle);

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmTransactionAbort0(IntPtr engineHandle);

    // ============ Provider Functions ============

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmProviderAdd0(
        IntPtr engineHandle,
        ref FWPM_PROVIDER0 provider,
        IntPtr sd);

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmProviderDeleteByKey0(
        IntPtr engineHandle,
        ref Guid key);


    // DEBUG ENUMS

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmFilterCreateEnumHandle0(
        IntPtr engineHandle,
        IntPtr enumTemplate,  // You can pass IntPtr.Zero for all filters
        out IntPtr enumHandle
    );

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmFilterEnum0(
        IntPtr engineHandle,
        IntPtr enumHandle,
        uint numEntriesRequested,
        out IntPtr entries,
        out uint numEntriesReturned
    );

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmFilterDestroyEnumHandle0(
        IntPtr engineHandle,
        IntPtr enumHandle
    );

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmFreeMemory0(ref IntPtr ptr);


    // ============ Sublayer Functions ============

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmSubLayerAdd0(
        IntPtr engineHandle,
        ref FWPM_SUBLAYER0 subLayer,
        IntPtr sd);

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmSubLayerDeleteByKey0(
        IntPtr engineHandle,
        ref Guid key);

    // ============ Filter Functions ============

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmFilterAdd0(
        IntPtr engineHandle,
        ref FWPM_FILTER0 filter,
        IntPtr sd,
        out ulong id);

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmFilterDeleteById0(
        IntPtr engineHandle,
        ulong id);

    [DllImport(FWPUCLNT)]
    public static extern uint FwpmFilterDeleteByKey0(
        IntPtr engineHandle,
        ref Guid key);
}

// ============ Structures ============

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct FWPM_SESSION0
{
    public Guid sessionKey;
    public FWPM_DISPLAY_DATA0 displayData;
    public uint flags;
    public uint txnWaitTimeoutInMSec;
    public uint processId;
    public IntPtr sid;
    public IntPtr username;
    [MarshalAs(UnmanagedType.Bool)]
    public bool kernelMode;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct FWPM_DISPLAY_DATA0
{
    [MarshalAs(UnmanagedType.LPWStr)]
    public string? name;
    [MarshalAs(UnmanagedType.LPWStr)]
    public string? description;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct FWPM_PROVIDER0
{
    public Guid providerKey;
    public FWPM_DISPLAY_DATA0 displayData;
    public uint flags;
    public FWP_BYTE_BLOB providerData;
    [MarshalAs(UnmanagedType.LPWStr)]
    public string? serviceName;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct FWPM_SUBLAYER0
{
    public Guid subLayerKey;
    public FWPM_DISPLAY_DATA0 displayData;
    public uint flags;
    public IntPtr providerKey;
    public FWP_BYTE_BLOB providerData;
    public ushort weight;
}

[StructLayout(LayoutKind.Sequential)]
public struct FWPM_FILTER0
{
    public Guid filterKey;
    public FWPM_DISPLAY_DATA0 displayData;
    public uint flags;
    public IntPtr providerKey;
    public FWP_BYTE_BLOB providerData;
    public Guid layerKey;
    public Guid subLayerKey;
    public FWP_VALUE0 weight;
    public uint numFilterConditions;
    public IntPtr filterCondition;
    public FWPM_ACTION0 action;
    public Guid providerContextKey; // C union {UINT64 rawContext; GUID providerContextKey} = 16 bytes
    public IntPtr reserved;         // C type: GUID* (pointer, 8 bytes on x64)
    public ulong filterId;
    public FWP_VALUE0 effectiveWeight;
}

[StructLayout(LayoutKind.Sequential)]
public struct FWPM_ACTION0
{
    public uint type;
    public Guid filterType; // Only used for FWP_ACTION_CALLOUT_*
}

[StructLayout(LayoutKind.Sequential)]
public struct FWPM_FILTER_CONDITION0
{
    public Guid fieldKey;
    public uint matchType;
    public FWP_CONDITION_VALUE0 conditionValue;
}

[StructLayout(LayoutKind.Sequential)]
public struct FWP_VALUE0
{
    public uint type;
    public FWP_VALUE0_UNION value;
}

[StructLayout(LayoutKind.Explicit)]
public unsafe struct FWP_VALUE0_UNION
{
    [FieldOffset(0)] public byte uint8;
    [FieldOffset(0)] public ushort uint16;
    [FieldOffset(0)] public uint uint32;
    [FieldOffset(0)] public ulong uint64;
    [FieldOffset(0)] public IntPtr ptr;
    [FieldOffset(0)] public IntPtr byteArray16;
    [FieldOffset(0)] public IntPtr byteBlob;
    [FieldOffset(0)] public IntPtr rangeValue;
}

[StructLayout(LayoutKind.Sequential)]
public struct FWP_CONDITION_VALUE0
{
    public uint type;
    public FWP_VALUE0_UNION value;
}

[StructLayout(LayoutKind.Sequential)]
public struct FWP_BYTE_BLOB
{
    public uint size;
    public IntPtr data;
}

[StructLayout(LayoutKind.Sequential)]
public struct FWP_RANGE0
{
    public FWP_VALUE0 valueLow;
    public FWP_VALUE0 valueHigh;
}

[StructLayout(LayoutKind.Sequential)]
public struct FWP_V4_ADDR_AND_MASK
{
    public uint addr;
    public uint mask;
}

[StructLayout(LayoutKind.Sequential)]
public unsafe struct FWP_V6_ADDR_AND_MASK
{
    public fixed byte addr[16];
    public byte prefixLength;
}
