#pragma once

#include <ntifs.h>
#include <wdf.h>
#include <initguid.h>
#include <guiddef.h>
#include <ndis.h>
#include <fwpsk.h>
#include <fwpmk.h>

// Device name and symlink
#define DEVICE_NAME     L"\\Device\\WireDogSplitTunnel"
#define SYMLINK_NAME    L"\\DosDevices\\WireDogSplitTunnel"

// Maximum tracked apps and per-app WFP filters
#define MAX_APPS        64
#define MAX_APP_PATH    520  // MAX_PATH * 2 for wide chars
// Exclude mode per app: 4 redirect + 2 AUTH_CONNECT PERMIT + 1 AUTH_CONNECT_V4 BLOCK + 2 AUTH_RECV_ACCEPT PERMIT = 9
// Include mode per app: 4 redirect + 2 AUTH_CONNECT PERMIT + 2 AUTH_RECV_ACCEPT PERMIT = 8
// Plus catch-all filters: 1 AUTH_CONNECT_V6 BLOCK
#define MAX_APP_FILTERS (MAX_APPS * 10 + 4)

// WFP filter weight hierarchy (FWP_UINT8, higher = evaluated first)
#define WEIGHT_APP_REDIRECT     0x0F  // Per-app redirect callout filters
#define WEIGHT_APP_AUTH_PERMIT  0x0E  // Per-app PERMIT on specific interface
#define WEIGHT_APP_AUTH_BLOCK   0x0D  // Per-app BLOCK (exclude mode V4 only)
#define WEIGHT_CATCHALL_BLOCK   0x0C  // Catch-all BLOCK on AUTH layers

// Split tunnel modes
#define ST_MODE_EXCLUDE  0   // Excluded apps bypass VPN
#define ST_MODE_INCLUDE  1   // Only included apps use VPN

// -------------------------------------------------------
// IOCTL codes — must match DriverClient.cs definitions
// CTL_CODE(FILE_DEVICE_UNKNOWN, function, METHOD_BUFFERED, FILE_ANY_ACCESS)
// -------------------------------------------------------
#define IOCTL_ST_INITIALIZE          CTL_CODE(FILE_DEVICE_UNKNOWN, 0x800, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ST_SET_CONFIGURATION   CTL_CODE(FILE_DEVICE_UNKNOWN, 0x801, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ST_REGISTER_IPS        CTL_CODE(FILE_DEVICE_UNKNOWN, 0x802, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ST_GET_STATE           CTL_CODE(FILE_DEVICE_UNKNOWN, 0x803, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ST_CLEAR_CONFIGURATION CTL_CODE(FILE_DEVICE_UNKNOWN, 0x804, METHOD_BUFFERED, FILE_ANY_ACCESS)

// -------------------------------------------------------
// IOCTL input structures (from user-mode service)
// -------------------------------------------------------

// Single app path entry
typedef struct _ST_APP_ENTRY {
    WCHAR Path[MAX_APP_PATH];
} ST_APP_ENTRY, *PST_APP_ENTRY;

// IOCTL_ST_SET_CONFIGURATION input
typedef struct _ST_CONFIGURATION {
    ULONG Mode;           // ST_MODE_EXCLUDE or ST_MODE_INCLUDE
    ULONG AppCount;
    ST_APP_ENTRY Apps[MAX_APPS];
} ST_CONFIGURATION, *PST_CONFIGURATION;

// IOCTL_ST_REGISTER_IPS input
typedef struct _ST_IP_ADDRESSES {
    ULONG TunnelIpV4;       // IPv4 in network byte order
    ULONG PhysicalIpV4;     // IPv4 in network byte order
    UCHAR TunnelIpV6[16];   // IPv6 address
    UCHAR PhysicalIpV6[16]; // IPv6 address
    BOOLEAN HasV6;
    ULONG PhysicalInterfaceIndex; // Physical adapter IF_INDEX for exclude mode AUTH filters
    ULONG TunnelInterfaceIndex;   // Tunnel adapter IF_INDEX for include mode AUTH filters
} ST_IP_ADDRESSES, *PST_IP_ADDRESSES;

// IOCTL_ST_GET_STATE output
typedef struct _ST_STATE {
    BOOLEAN Initialized;
    ULONG   Mode;
    ULONG   AppCount;
    ULONG   ActiveFilterCount;
    // Diagnostic counters (V4 + V6 combined)
    ULONG   ClassifyCallCount;
    ULONG   ClassifyMatchCount;
    ULONG   RedirectSuccessCount;
    ULONG   RedirectErrorCount;
    // V6-specific counters
    ULONG   ClassifyCallCountV6;
    ULONG   ClassifyMatchCountV6;
    ULONG   RedirectSuccessCountV6;
    ULONG   RedirectErrorCountV6;
} ST_STATE, *PST_STATE;

// -------------------------------------------------------
// Global driver context
// -------------------------------------------------------
typedef struct _ST_DRIVER_CONTEXT {
    WDFDEVICE Device;
    HANDLE    EngineHandle;      // WFP engine handle
    UINT32    CalloutIdV4;       // ALE_BIND_REDIRECT_V4 callout ID
    UINT32    CalloutIdV6;       // ALE_BIND_REDIRECT_V6 callout ID
    UINT32    ConnectCalloutIdV4; // ALE_CONNECT_REDIRECT_V4 callout ID
    UINT32    ConnectCalloutIdV6; // ALE_CONNECT_REDIRECT_V6 callout ID

    // Configuration (protected by ConfigLock)
    KSPIN_LOCK ConfigLock;
    BOOLEAN    Initialized;
    ULONG      Mode;             // ST_MODE_EXCLUDE or ST_MODE_INCLUDE
    ULONG      AppCount;
    ST_APP_ENTRY Apps[MAX_APPS];

    // IP addresses
    ULONG   TunnelIpV4;
    ULONG   PhysicalIpV4;
    UCHAR   TunnelIpV6[16];
    UCHAR   PhysicalIpV6[16];
    BOOLEAN HasV6;
    BOOLEAN IpRegistered;
    ULONG   PhysicalInterfaceIndex; // Physical adapter IF_INDEX (exclude mode AUTH filters)
    ULONG   TunnelInterfaceIndex;   // Tunnel adapter IF_INDEX (include mode AUTH filters)

    // Per-app WFP filter tracking
    ULONG   AppFilterCount;
    UINT64  AppFilterIds[MAX_APP_FILTERS];

    // Diagnostic counters (interlocked, no lock needed)
    volatile LONG ClassifyCallCount;
    volatile LONG ClassifyMatchCount;
    volatile LONG RedirectSuccessCount;
    volatile LONG RedirectErrorCount;
    // V6-specific counters
    volatile LONG ClassifyCallCountV6;
    volatile LONG ClassifyMatchCountV6;
    volatile LONG RedirectSuccessCountV6;
    volatile LONG RedirectErrorCountV6;

} ST_DRIVER_CONTEXT, *PST_DRIVER_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(ST_DRIVER_CONTEXT, GetDriverContext)

// -------------------------------------------------------
// Function declarations
// -------------------------------------------------------

// driver.c
DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_UNLOAD EvtDriverUnload;
EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL EvtIoDeviceControl;

// wfp.c
NTSTATUS WfpInitialize(_In_ PST_DRIVER_CONTEXT Context);
VOID     WfpUninitialize(_In_ PST_DRIVER_CONTEXT Context);
NTSTATUS WfpAddAppFilters(_In_ PST_DRIVER_CONTEXT Context);
VOID     WfpRemoveAppFilters(_In_ PST_DRIVER_CONTEXT Context);
