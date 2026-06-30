/*
 * WireDog Split Tunnel Driver - WFP Callout Implementation
 *
 * Registers WFP callouts at ALE_BIND_REDIRECT layers to redirect
 * socket binds for split-tunneled applications.
 *
 * Bind redirect approach:
 *   - Excluded apps (exclude mode) or non-included apps (include mode)
 *     have their socket bind redirected to the physical adapter IP,
 *     causing traffic to bypass the WireGuard tunnel.
 *   - All other apps bind normally and route through the tunnel.
 */

#include "common.h"
#include <ws2ipdef.h>
#include <in6addr.h>

// External reference to global context (set in driver.c)
extern PST_DRIVER_CONTEXT g_DriverContext;

// {A7F3E2B1-4C8D-4F5A-9E6B-1D2C3A4B5C6D}
DEFINE_GUID(WIREDOG_CALLOUT_V4,
    0xa7f3e2b1, 0x4c8d, 0x4f5a,
    0x9e, 0x6b, 0x1d, 0x2c, 0x3a, 0x4b, 0x5c, 0x6d);

// {B8F4E3C2-5D9E-5A6B-AF7C-2E3D4B5C6D7E}
DEFINE_GUID(WIREDOG_CALLOUT_V6,
    0xb8f4e3c2, 0x5d9e, 0x5a6b,
    0xaf, 0x7c, 0x2e, 0x3d, 0x4b, 0x5c, 0x6d, 0x7e);

// {C9A5F4D3-6EAF-6B7C-BA8D-3F4E5C6D7E8F}
DEFINE_GUID(WIREDOG_SUBLAYER,
    0xc9a5f4d3, 0x6eaf, 0x6b7c,
    0xba, 0x8d, 0x3f, 0x4e, 0x5c, 0x6d, 0x7e, 0x8f);

// Connect redirect GUIDs (TCP connections need connect redirect for reliable routing)
// {14B0A7E5-3C6D-4E8F-B9A2-5D6E7F8A9B0C}
DEFINE_GUID(WIREDOG_CONNECT_CALLOUT_V4,
    0x14b0a7e5, 0x3c6d, 0x4e8f,
    0xb9, 0xa2, 0x5d, 0x6e, 0x7f, 0x8a, 0x9b, 0x0c);

// {F2D8C7A6-9BDC-9EAF-EDBA-6C7B8F9A0B12}
DEFINE_GUID(WIREDOG_CONNECT_CALLOUT_V6,
    0xf2d8c7a6, 0x9bdc, 0x9eaf,
    0xed, 0xba, 0x6c, 0x7b, 0x8f, 0x9a, 0x0b, 0x12);

// Forward declarations
VOID NTAPI WfpBindRedirectClassifyV4(
    _In_ const FWPS_INCOMING_VALUES0* inFixedValues,
    _In_ const FWPS_INCOMING_METADATA_VALUES0* inMetaValues,
    _Inout_opt_ void* layerData,
    _In_opt_ const void* classifyContext,
    _In_ const FWPS_FILTER3* filter,
    _In_ UINT64 flowContext,
    _Inout_ FWPS_CLASSIFY_OUT0* classifyOut);

VOID NTAPI WfpBindRedirectClassifyV6(
    _In_ const FWPS_INCOMING_VALUES0* inFixedValues,
    _In_ const FWPS_INCOMING_METADATA_VALUES0* inMetaValues,
    _Inout_opt_ void* layerData,
    _In_opt_ const void* classifyContext,
    _In_ const FWPS_FILTER3* filter,
    _In_ UINT64 flowContext,
    _Inout_ FWPS_CLASSIFY_OUT0* classifyOut);

VOID NTAPI WfpConnectRedirectClassifyV4(
    _In_ const FWPS_INCOMING_VALUES0* inFixedValues,
    _In_ const FWPS_INCOMING_METADATA_VALUES0* inMetaValues,
    _Inout_opt_ void* layerData,
    _In_opt_ const void* classifyContext,
    _In_ const FWPS_FILTER3* filter,
    _In_ UINT64 flowContext,
    _Inout_ FWPS_CLASSIFY_OUT0* classifyOut);

VOID NTAPI WfpConnectRedirectClassifyV6(
    _In_ const FWPS_INCOMING_VALUES0* inFixedValues,
    _In_ const FWPS_INCOMING_METADATA_VALUES0* inMetaValues,
    _Inout_opt_ void* layerData,
    _In_opt_ const void* classifyContext,
    _In_ const FWPS_FILTER3* filter,
    _In_ UINT64 flowContext,
    _Inout_ FWPS_CLASSIFY_OUT0* classifyOut);

NTSTATUS NTAPI WfpNotifyCallback(
    _In_ FWPS_CALLOUT_NOTIFY_TYPE notifyType,
    _In_ const GUID* filterKey,
    _Inout_ FWPS_FILTER3* filter);

/*
 * Check if an IPv4 address is local (loopback, LAN, multicast, broadcast).
 * addr is in HOST byte order (as provided by WFP inFixedValues).
 * Traffic to local addresses should NOT be redirected.
 */
static BOOLEAN IsLocalIpv4Address(UINT32 addr)
{
    // Loopback: 127.0.0.0/8
    if ((addr & 0xFF000000) == 0x7F000000)
        return TRUE;
    // Link-local: 169.254.0.0/16
    if ((addr & 0xFFFF0000) == 0xA9FE0000)
        return TRUE;
    // 10.0.0.0/8
    if ((addr & 0xFF000000) == 0x0A000000)
        return TRUE;
    // 172.16.0.0/12
    if ((addr & 0xFFF00000) == 0xAC100000)
        return TRUE;
    // 192.168.0.0/16
    if ((addr & 0xFFFF0000) == 0xC0A80000)
        return TRUE;
    // Multicast: 224.0.0.0/4
    if ((addr & 0xF0000000) == 0xE0000000)
        return TRUE;
    // Broadcast: 255.255.255.255
    if (addr == 0xFFFFFFFF)
        return TRUE;
    return FALSE;
}

/*
 * Check if an IPv6 address is local.
 * Traffic to local addresses should NOT be redirected.
 */
static BOOLEAN IsLocalIpv6Address(const UINT8* addr)
{
    ULONG i;
    BOOLEAN allZero;

    // Unspecified: ::/128
    allZero = TRUE;
    for (i = 0; i < 16; i++) {
        if (addr[i] != 0) { allZero = FALSE; break; }
    }
    if (allZero) return TRUE;

    // Loopback: ::1/128
    allZero = TRUE;
    for (i = 0; i < 15; i++) {
        if (addr[i] != 0) { allZero = FALSE; break; }
    }
    if (allZero && addr[15] == 1) return TRUE;

    // Link-local: fe80::/10
    if (addr[0] == 0xFE && (addr[1] & 0xC0) == 0x80)
        return TRUE;
    // Site-local: fec0::/10 (deprecated but still check)
    if (addr[0] == 0xFE && (addr[1] & 0xC0) == 0xC0)
        return TRUE;
    // Multicast: ff00::/8
    if (addr[0] == 0xFF)
        return TRUE;
    // ULA: fc00::/7
    if ((addr[0] & 0xFE) == 0xFC)
        return TRUE;
    // Teredo: 2001:0000::/32
    if (addr[0] == 0x20 && addr[1] == 0x01 && addr[2] == 0x00 && addr[3] == 0x00)
        return TRUE;

    return FALSE;
}

/*
 * WFP classify callback for ALE_BIND_REDIRECT_V4
 *
 * When a socket bind is intercepted:
 * 1. Check if the process should be redirected
 * 2. If yes, modify the local address to the physical adapter IP
 * 3. This causes the OS to route traffic outside the VPN tunnel
 */
VOID NTAPI WfpBindRedirectClassifyV4(
    _In_ const FWPS_INCOMING_VALUES0* inFixedValues,
    _In_ const FWPS_INCOMING_METADATA_VALUES0* inMetaValues,
    _Inout_opt_ void* layerData,
    _In_opt_ const void* classifyContext,
    _In_ const FWPS_FILTER3* filter,
    _In_ UINT64 flowContext,
    _Inout_ FWPS_CLASSIFY_OUT0* classifyOut)
{
    PST_DRIVER_CONTEXT ctx = g_DriverContext;
    KIRQL oldIrql;
    ULONG physicalIp;

    UNREFERENCED_PARAMETER(inMetaValues);
    UNREFERENCED_PARAMETER(layerData);
    UNREFERENCED_PARAMETER(flowContext);

    if (!ctx) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    InterlockedIncrement(&ctx->ClassifyCallCount);

    // Check if we have write permission
    if (!(classifyOut->rights & FWPS_RIGHT_ACTION_WRITE)) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    // Skip reauthorization events to prevent redirect loops
    {
        UINT32 flags = inFixedValues->incomingValue[
            FWPS_FIELD_ALE_BIND_REDIRECT_V4_FLAGS].value.uint32;
        if (flags & FWP_CONDITION_FLAG_IS_REAUTHORIZE) {
            classifyOut->actionType = FWP_ACTION_PERMIT;
            return;
        }
    }

    // Per-app WFP filters ensure only matched apps reach this callout.
    // No process lookup needed — just redirect.

    if (!ctx->Initialized || !ctx->IpRegistered) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    InterlockedIncrement(&ctx->ClassifyMatchCount);

    // Determine target IP: include mode per-app (rawContext=1) redirects to tunnel IP,
    // catch-all (rawContext=0) redirects to physical IP.
    KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
    if (filter->context == 1) {
        physicalIp = ctx->TunnelIpV4;  // Redirect included apps to tunnel IP
    } else {
        physicalIp = ctx->PhysicalIpV4;
    }
    KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);

    if (physicalIp == 0) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        if (filter->context == 1)
            classifyOut->rights &= ~FWPS_RIGHT_ACTION_WRITE;
        return;
    }

    if (!classifyContext) {
        InterlockedIncrement(&ctx->RedirectErrorCount);
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    // Acquire classify handle from classifyContext
    UINT64 classifyHandle = 0;
    NTSTATUS status = FwpsAcquireClassifyHandle0(
        (void*)classifyContext, 0, &classifyHandle);
    if (!NT_SUCCESS(status)) {
        InterlockedIncrement(&ctx->RedirectErrorCount);
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsAcquireClassifyHandle failed 0x%x\n", status));
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    // Get writable pointer to the bind request
    FWPS_BIND_REQUEST0* bindRequest = NULL;
    status = FwpsAcquireWritableLayerDataPointer0(
        classifyHandle,
        filter->filterId,
        0,
        (PVOID*)&bindRequest,
        classifyOut);
    if (!NT_SUCCESS(status)) {
        InterlockedIncrement(&ctx->RedirectErrorCount);
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsAcquireWritableLayerDataPointer failed 0x%x\n", status));
        FwpsReleaseClassifyHandle0(classifyHandle);
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    // Modify the local address to target IP (tunnel for included apps, physical for others)
    SOCKADDR_IN* addr = (SOCKADDR_IN*)&bindRequest->localAddressAndPort;
    addr->sin_addr.S_un.S_addr = physicalIp;

    // Apply the modification
    FwpsApplyModifiedLayerData0(classifyHandle, bindRequest, 0);
    FwpsReleaseClassifyHandle0(classifyHandle);

    InterlockedIncrement(&ctx->RedirectSuccessCount);

    classifyOut->actionType = FWP_ACTION_PERMIT;
    classifyOut->rights &= ~FWPS_RIGHT_ACTION_WRITE;
}

/*
 * WFP classify callback for ALE_BIND_REDIRECT_V6
 */
VOID NTAPI WfpBindRedirectClassifyV6(
    _In_ const FWPS_INCOMING_VALUES0* inFixedValues,
    _In_ const FWPS_INCOMING_METADATA_VALUES0* inMetaValues,
    _Inout_opt_ void* layerData,
    _In_opt_ const void* classifyContext,
    _In_ const FWPS_FILTER3* filter,
    _In_ UINT64 flowContext,
    _Inout_ FWPS_CLASSIFY_OUT0* classifyOut)
{
    PST_DRIVER_CONTEXT ctx = g_DriverContext;
    KIRQL oldIrql;
    BOOLEAN hasV6;
    UCHAR physicalIpV6[16];
    UINT64 classifyHandle = 0;
    NTSTATUS status;
    FWPS_BIND_REQUEST0* bindRequest = NULL;
    SOCKADDR_IN6* addr6;

    UNREFERENCED_PARAMETER(inMetaValues);
    UNREFERENCED_PARAMETER(layerData);
    UNREFERENCED_PARAMETER(flowContext);

    if (!ctx || !classifyContext) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    InterlockedIncrement(&ctx->ClassifyCallCount);
    InterlockedIncrement(&ctx->ClassifyCallCountV6);

    if (!(classifyOut->rights & FWPS_RIGHT_ACTION_WRITE)) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    // Skip reauthorization events to prevent redirect loops
    {
        UINT32 flags = inFixedValues->incomingValue[
            FWPS_FIELD_ALE_BIND_REDIRECT_V6_FLAGS].value.uint32;
        if (flags & FWP_CONDITION_FLAG_IS_REAUTHORIZE) {
            classifyOut->actionType = FWP_ACTION_PERMIT;
            return;
        }
    }

    // Per-app WFP filters ensure only matched apps reach this callout.
    if (!ctx->Initialized || !ctx->IpRegistered) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    InterlockedIncrement(&ctx->ClassifyMatchCount);
    InterlockedIncrement(&ctx->ClassifyMatchCountV6);

    // Determine target IPv6: include mode per-app (rawContext=1) redirects to tunnel IPv6,
    // catch-all (rawContext=0) redirects to physical IPv6.
    KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
    hasV6 = ctx->HasV6;
    if (hasV6) {
        if (filter->context == 1) {
            RtlCopyMemory(physicalIpV6, ctx->TunnelIpV6, 16);  // Redirect included apps to tunnel IPv6
        } else {
            RtlCopyMemory(physicalIpV6, ctx->PhysicalIpV6, 16);
        }
    }
    KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);

    if (!hasV6) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        if (filter->context == 1)
            classifyOut->rights &= ~FWPS_RIGHT_ACTION_WRITE;
        return;
    }

    status = FwpsAcquireClassifyHandle0(
        (void*)classifyContext, 0, &classifyHandle);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsAcquireClassifyHandle V6 failed 0x%x\n", status));
        InterlockedIncrement(&ctx->RedirectErrorCount);
        InterlockedIncrement(&ctx->RedirectErrorCountV6);
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    status = FwpsAcquireWritableLayerDataPointer0(
        classifyHandle,
        filter->filterId,
        0,
        (PVOID*)&bindRequest,
        classifyOut);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsAcquireWritableLayerDataPointer V6 failed 0x%x\n", status));
        FwpsReleaseClassifyHandle0(classifyHandle);
        InterlockedIncrement(&ctx->RedirectErrorCount);
        InterlockedIncrement(&ctx->RedirectErrorCountV6);
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    addr6 = (SOCKADDR_IN6*)&bindRequest->localAddressAndPort;
    RtlCopyMemory(&addr6->sin6_addr, physicalIpV6, 16);

    FwpsApplyModifiedLayerData0(classifyHandle, bindRequest, 0);
    FwpsReleaseClassifyHandle0(classifyHandle);

    InterlockedIncrement(&ctx->RedirectSuccessCount);
    InterlockedIncrement(&ctx->RedirectSuccessCountV6);

    classifyOut->actionType = FWP_ACTION_PERMIT;
    classifyOut->rights &= ~FWPS_RIGHT_ACTION_WRITE;
}

/*
 * WFP classify callback for ALE_CONNECT_REDIRECT_V6
 *
 * IPv6 bind redirect alone doesn't influence routing on Windows
 * (unlike IPv4, the strong host model doesn't enforce source-based route selection).
 * This connect redirect sets the local address at connect time, which DOES
 * influence the routing decision per Microsoft WFP documentation.
 */
VOID NTAPI WfpConnectRedirectClassifyV6(
    _In_ const FWPS_INCOMING_VALUES0* inFixedValues,
    _In_ const FWPS_INCOMING_METADATA_VALUES0* inMetaValues,
    _Inout_opt_ void* layerData,
    _In_opt_ const void* classifyContext,
    _In_ const FWPS_FILTER3* filter,
    _In_ UINT64 flowContext,
    _Inout_ FWPS_CLASSIFY_OUT0* classifyOut)
{
    PST_DRIVER_CONTEXT ctx = g_DriverContext;
    KIRQL oldIrql;
    BOOLEAN hasV6;
    UCHAR physicalIpV6[16];
    UINT64 classifyHandle = 0;
    NTSTATUS status;
    FWPS_CONNECT_REQUEST0* connectRequest = NULL;
    SOCKADDR_IN6* addr6;

    UNREFERENCED_PARAMETER(layerData);
    UNREFERENCED_PARAMETER(flowContext);
    UNREFERENCED_PARAMETER(inMetaValues);

    if (!ctx || !classifyContext) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    InterlockedIncrement(&ctx->ClassifyCallCount);
    InterlockedIncrement(&ctx->ClassifyCallCountV6);

    if (!(classifyOut->rights & FWPS_RIGHT_ACTION_WRITE)) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    // Skip reauthorization events to prevent redirect loops
    {
        UINT32 flags = inFixedValues->incomingValue[
            FWPS_FIELD_ALE_CONNECT_REDIRECT_V6_FLAGS].value.uint32;
        if (flags & FWP_CONDITION_FLAG_IS_REAUTHORIZE) {
            classifyOut->actionType = FWP_ACTION_PERMIT;
            return;
        }
    }

    // Check if remote endpoint is local — don't redirect local traffic
    {
        const FWP_BYTE_ARRAY16* remoteAddr = inFixedValues->incomingValue[
            FWPS_FIELD_ALE_CONNECT_REDIRECT_V6_IP_REMOTE_ADDRESS].value.byteArray16;
        if (remoteAddr && IsLocalIpv6Address(remoteAddr->byteArray16)) {
            classifyOut->actionType = FWP_ACTION_PERMIT;
            return;
        }
    }

    // Per-app WFP filters ensure only matched apps reach this callout.
    if (!ctx->Initialized || !ctx->IpRegistered) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    InterlockedIncrement(&ctx->ClassifyMatchCount);
    InterlockedIncrement(&ctx->ClassifyMatchCountV6);

    // Determine target IPv6: include mode per-app (rawContext=1) redirects to tunnel IPv6,
    // catch-all (rawContext=0) redirects to physical IPv6.
    KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
    hasV6 = ctx->HasV6;
    if (hasV6) {
        if (filter->context == 1) {
            RtlCopyMemory(physicalIpV6, ctx->TunnelIpV6, 16);  // Redirect included apps to tunnel IPv6
        } else {
            RtlCopyMemory(physicalIpV6, ctx->PhysicalIpV6, 16);
        }
    }
    KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);

    if (!hasV6) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        if (filter->context == 1)
            classifyOut->rights &= ~FWPS_RIGHT_ACTION_WRITE;
        return;
    }

    status = FwpsAcquireClassifyHandle0(
        (void*)classifyContext, 0, &classifyHandle);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsAcquireClassifyHandle ConnectV6 failed 0x%x\n", status));
        InterlockedIncrement(&ctx->RedirectErrorCount);
        InterlockedIncrement(&ctx->RedirectErrorCountV6);
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    status = FwpsAcquireWritableLayerDataPointer0(
        classifyHandle,
        filter->filterId,
        0,
        (PVOID*)&connectRequest,
        classifyOut);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsAcquireWritableLayerDataPointer ConnectV6 failed 0x%x\n", status));
        FwpsReleaseClassifyHandle0(classifyHandle);
        InterlockedIncrement(&ctx->RedirectErrorCount);
        InterlockedIncrement(&ctx->RedirectErrorCountV6);
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    /* Set local address to target IPv6 (tunnel for included apps, physical for others).
     * sin6_scope_id left as 0 per MSDN (only used for link-local addresses). */
    addr6 = (SOCKADDR_IN6*)&connectRequest->localAddressAndPort;
    RtlCopyMemory(&addr6->sin6_addr, physicalIpV6, 16);

    FwpsApplyModifiedLayerData0(classifyHandle, connectRequest, 0);
    FwpsReleaseClassifyHandle0(classifyHandle);

    InterlockedIncrement(&ctx->RedirectSuccessCount);
    InterlockedIncrement(&ctx->RedirectSuccessCountV6);

    classifyOut->actionType = FWP_ACTION_PERMIT;
    classifyOut->rights &= ~FWPS_RIGHT_ACTION_WRITE;
}

/*
 * WFP classify callback for ALE_CONNECT_REDIRECT_V4
 *
 * Intercepts TCP connect() calls for matched processes and redirects
 * the local address to the physical adapter IP, ensuring correct routing.
 * BIND_REDIRECT alone may not reliably influence IPv4 TCP routing for
 * all applications.
 */
VOID NTAPI WfpConnectRedirectClassifyV4(
    _In_ const FWPS_INCOMING_VALUES0* inFixedValues,
    _In_ const FWPS_INCOMING_METADATA_VALUES0* inMetaValues,
    _Inout_opt_ void* layerData,
    _In_opt_ const void* classifyContext,
    _In_ const FWPS_FILTER3* filter,
    _In_ UINT64 flowContext,
    _Inout_ FWPS_CLASSIFY_OUT0* classifyOut)
{
    PST_DRIVER_CONTEXT ctx = g_DriverContext;
    KIRQL oldIrql;
    ULONG physicalIp;
    UINT64 classifyHandle = 0;
    NTSTATUS status;
    FWPS_CONNECT_REQUEST0* connectRequest = NULL;
    SOCKADDR_IN* addr;

    UNREFERENCED_PARAMETER(layerData);
    UNREFERENCED_PARAMETER(flowContext);
    UNREFERENCED_PARAMETER(inMetaValues);

    if (!ctx || !classifyContext) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    InterlockedIncrement(&ctx->ClassifyCallCount);

    if (!(classifyOut->rights & FWPS_RIGHT_ACTION_WRITE)) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    // Skip reauthorization events to prevent redirect loops
    {
        UINT32 flags = inFixedValues->incomingValue[
            FWPS_FIELD_ALE_CONNECT_REDIRECT_V4_FLAGS].value.uint32;
        if (flags & FWP_CONDITION_FLAG_IS_REAUTHORIZE) {
            classifyOut->actionType = FWP_ACTION_PERMIT;
            return;
        }
    }

    // Check if remote endpoint is local — don't redirect local traffic
    {
        UINT32 remoteAddr = inFixedValues->incomingValue[
            FWPS_FIELD_ALE_CONNECT_REDIRECT_V4_IP_REMOTE_ADDRESS].value.uint32;
        if (IsLocalIpv4Address(remoteAddr)) {
            classifyOut->actionType = FWP_ACTION_PERMIT;
            return;
        }
    }

    // Per-app WFP filters ensure only matched apps reach this callout.
    if (!ctx->Initialized || !ctx->IpRegistered) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    InterlockedIncrement(&ctx->ClassifyMatchCount);

    // Determine target IP: include mode per-app (rawContext=1) redirects to tunnel IP,
    // catch-all (rawContext=0) redirects to physical IP.
    KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
    if (filter->context == 1) {
        physicalIp = ctx->TunnelIpV4;  // Redirect included apps to tunnel IP
    } else {
        physicalIp = ctx->PhysicalIpV4;
    }
    KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);

    if (physicalIp == 0) {
        classifyOut->actionType = FWP_ACTION_PERMIT;
        if (filter->context == 1)
            classifyOut->rights &= ~FWPS_RIGHT_ACTION_WRITE;
        return;
    }

    status = FwpsAcquireClassifyHandle0(
        (void*)classifyContext, 0, &classifyHandle);
    if (!NT_SUCCESS(status)) {
        InterlockedIncrement(&ctx->RedirectErrorCount);
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsAcquireClassifyHandle ConnectV4 failed 0x%x\n", status));
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    status = FwpsAcquireWritableLayerDataPointer0(
        classifyHandle,
        filter->filterId,
        0,
        (PVOID*)&connectRequest,
        classifyOut);
    if (!NT_SUCCESS(status)) {
        FwpsReleaseClassifyHandle0(classifyHandle);
        InterlockedIncrement(&ctx->RedirectErrorCount);
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsAcquireWritableLayerDataPointer ConnectV4 failed 0x%x\n", status));
        classifyOut->actionType = FWP_ACTION_PERMIT;
        return;
    }

    // Modify the local address to target IP (tunnel for included apps, physical for others)
    addr = (SOCKADDR_IN*)&connectRequest->localAddressAndPort;
    addr->sin_addr.S_un.S_addr = physicalIp;

    FwpsApplyModifiedLayerData0(classifyHandle, connectRequest, 0);
    FwpsReleaseClassifyHandle0(classifyHandle);

    InterlockedIncrement(&ctx->RedirectSuccessCount);

    classifyOut->actionType = FWP_ACTION_PERMIT;
    classifyOut->rights &= ~FWPS_RIGHT_ACTION_WRITE;
}

/*
 * WFP notify callback (required but we don't need to do anything here)
 */
NTSTATUS NTAPI WfpNotifyCallback(
    _In_ FWPS_CALLOUT_NOTIFY_TYPE notifyType,
    _In_ const GUID* filterKey,
    _Inout_ FWPS_FILTER3* filter)
{
    UNREFERENCED_PARAMETER(notifyType);
    UNREFERENCED_PARAMETER(filterKey);
    UNREFERENCED_PARAMETER(filter);
    return STATUS_SUCCESS;
}

/*
 * Register WFP callouts and filters
 */
NTSTATUS WfpInitialize(_In_ PST_DRIVER_CONTEXT ctx)
{
    NTSTATUS status;
    FWPM_SESSION0 session = { 0 };
    FWPM_SUBLAYER0 sublayer = { 0 };
    FWPS_CALLOUT3 sCallout = { 0 };
    FWPM_CALLOUT0 mCallout = { 0 };

    // Use a dynamic session so WFP auto-cleans up on driver crash/unload
    session.flags = FWPM_SESSION_FLAG_DYNAMIC;

    status = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, &session,
        &ctx->EngineHandle);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmEngineOpen failed 0x%x\n", status));
        return status;
    }

    // Register sublayer
    sublayer.subLayerKey = WIREDOG_SUBLAYER;
    sublayer.displayData.name = L"WireDog Split Tunnel Sublayer";
    sublayer.weight = 0xFFFF;  // Highest weight — evaluate before other sublayers (e.g. Windows Firewall)

    status = FwpmSubLayerAdd0(ctx->EngineHandle, &sublayer, NULL);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmSubLayerAdd failed 0x%x\n", status));
        goto cleanup;
    }

    // --- Register V4 callout ---
    sCallout.calloutKey = WIREDOG_CALLOUT_V4;
    sCallout.classifyFn = WfpBindRedirectClassifyV4;
    sCallout.notifyFn = WfpNotifyCallback;
    sCallout.flowDeleteFn = NULL;

    status = FwpsCalloutRegister3(WdfDeviceWdmGetDeviceObject(ctx->Device),
        &sCallout, &ctx->CalloutIdV4);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsCalloutRegister V4 failed 0x%x\n", status));
        goto cleanup;
    }

    // Add management callout V4
    mCallout.calloutKey = WIREDOG_CALLOUT_V4;
    mCallout.displayData.name = L"WireDog Bind Redirect V4";
    mCallout.applicableLayer = FWPM_LAYER_ALE_BIND_REDIRECT_V4;

    status = FwpmCalloutAdd0(ctx->EngineHandle, &mCallout, NULL, NULL);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmCalloutAdd V4 failed 0x%x\n", status));
        goto cleanup;
    }

    // No global filters — per-app filters are created by WfpAddAppFilters()

    // --- Register V4 connect redirect callout (for TCP) ---
    RtlZeroMemory(&sCallout, sizeof(sCallout));
    sCallout.calloutKey = WIREDOG_CONNECT_CALLOUT_V4;
    sCallout.classifyFn = WfpConnectRedirectClassifyV4;
    sCallout.notifyFn = WfpNotifyCallback;
    sCallout.flowDeleteFn = NULL;

    status = FwpsCalloutRegister3(WdfDeviceWdmGetDeviceObject(ctx->Device),
        &sCallout, &ctx->ConnectCalloutIdV4);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsCalloutRegister ConnectV4 failed 0x%x\n", status));
        goto cleanup;
    }

    // Add management callout for connect redirect V4
    RtlZeroMemory(&mCallout, sizeof(mCallout));
    mCallout.calloutKey = WIREDOG_CONNECT_CALLOUT_V4;
    mCallout.displayData.name = L"WireDog Connect Redirect V4";
    mCallout.applicableLayer = FWPM_LAYER_ALE_CONNECT_REDIRECT_V4;

    status = FwpmCalloutAdd0(ctx->EngineHandle, &mCallout, NULL, NULL);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmCalloutAdd ConnectV4 failed 0x%x\n", status));
        goto cleanup;
    }

    // --- Register V6 callout ---
    RtlZeroMemory(&sCallout, sizeof(sCallout));
    sCallout.calloutKey = WIREDOG_CALLOUT_V6;
    sCallout.classifyFn = WfpBindRedirectClassifyV6;
    sCallout.notifyFn = WfpNotifyCallback;
    sCallout.flowDeleteFn = NULL;

    status = FwpsCalloutRegister3(WdfDeviceWdmGetDeviceObject(ctx->Device),
        &sCallout, &ctx->CalloutIdV6);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsCalloutRegister V6 failed 0x%x\n", status));
        goto cleanup;
    }

    // Add management callout V6
    RtlZeroMemory(&mCallout, sizeof(mCallout));
    mCallout.calloutKey = WIREDOG_CALLOUT_V6;
    mCallout.displayData.name = L"WireDog Bind Redirect V6";
    mCallout.applicableLayer = FWPM_LAYER_ALE_BIND_REDIRECT_V6;

    status = FwpmCalloutAdd0(ctx->EngineHandle, &mCallout, NULL, NULL);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmCalloutAdd V6 failed 0x%x\n", status));
        goto cleanup;
    }

    // --- Register V6 connect redirect callout ---
    // IPv6 needs connect redirect because bind redirect alone doesn't influence
    // IPv6 routing on Windows (strong host model not enforced for IPv6 route selection)
    RtlZeroMemory(&sCallout, sizeof(sCallout));
    sCallout.calloutKey = WIREDOG_CONNECT_CALLOUT_V6;
    sCallout.classifyFn = WfpConnectRedirectClassifyV6;
    sCallout.notifyFn = WfpNotifyCallback;
    sCallout.flowDeleteFn = NULL;

    status = FwpsCalloutRegister3(WdfDeviceWdmGetDeviceObject(ctx->Device),
        &sCallout, &ctx->ConnectCalloutIdV6);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpsCalloutRegister ConnectV6 failed 0x%x\n", status));
        goto cleanup;
    }

    // Add management callout for connect redirect V6
    RtlZeroMemory(&mCallout, sizeof(mCallout));
    mCallout.calloutKey = WIREDOG_CONNECT_CALLOUT_V6;
    mCallout.displayData.name = L"WireDog Connect Redirect V6";
    mCallout.applicableLayer = FWPM_LAYER_ALE_CONNECT_REDIRECT_V6;

    status = FwpmCalloutAdd0(ctx->EngineHandle, &mCallout, NULL, NULL);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmCalloutAdd ConnectV6 failed 0x%x\n", status));
        goto cleanup;
    }

    KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
        "WireDogSplitTunnel: WFP callouts registered (V4+V6 bind + connect redirect). No filters yet.\n"));

    return STATUS_SUCCESS;

cleanup:
    WfpUninitialize(ctx);
    return status;
}

/*
 * Unregister WFP callouts and close engine
 */
VOID WfpUninitialize(_In_ PST_DRIVER_CONTEXT ctx)
{
    // Remove per-app filters first
    WfpRemoveAppFilters(ctx);

    if (ctx->CalloutIdV4 != 0) {
        FwpsCalloutUnregisterById0(ctx->CalloutIdV4);
        ctx->CalloutIdV4 = 0;
    }
    if (ctx->CalloutIdV6 != 0) {
        FwpsCalloutUnregisterById0(ctx->CalloutIdV6);
        ctx->CalloutIdV6 = 0;
    }
    if (ctx->ConnectCalloutIdV4 != 0) {
        FwpsCalloutUnregisterById0(ctx->ConnectCalloutIdV4);
        ctx->ConnectCalloutIdV4 = 0;
    }
    if (ctx->ConnectCalloutIdV6 != 0) {
        FwpsCalloutUnregisterById0(ctx->ConnectCalloutIdV6);
        ctx->ConnectCalloutIdV6 = 0;
    }
    if (ctx->EngineHandle != NULL) {
        // Dynamic session: closing the handle auto-removes sublayer, callouts, filters
        FwpmEngineClose0(ctx->EngineHandle);
        ctx->EngineHandle = NULL;
    }

    KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
        "WireDogSplitTunnel: WFP uninitialized\n"));
}

/*
 * Convert an NT path to lowercase in-place for WFP app ID matching.
 */
static VOID LowercaseWideString(PWCHAR str, USHORT charCount)
{
    USHORT i;
    for (i = 0; i < charCount; i++) {
        if (str[i] >= L'A' && str[i] <= L'Z')
            str[i] = str[i] - L'A' + L'a';
    }
}

/*
 * Add a single WFP filter with an app-path condition on the specified layer.
 * Returns STATUS_SUCCESS on success, stores filter ID in ctx->AppFilterIds[].
 */
static NTSTATUS WfpAddSingleAppFilter(
    _In_ PST_DRIVER_CONTEXT ctx,
    _In_ const WCHAR* appPath,
    _In_ USHORT appPathChars,
    _In_ const GUID* layerKey,
    _In_ const GUID* calloutKey,
    _In_ BOOLEAN isPermit)
{
    NTSTATUS status;
    FWPM_FILTER0 wfpFilter = { 0 };
    FWPM_FILTER_CONDITION0 condition = { 0 };
    FWP_BYTE_BLOB appBlob = { 0 };
    UINT64 filterId = 0;
    PWCHAR lowerPath = NULL;
    ULONG pathBytes;

    if (ctx->AppFilterCount >= MAX_APP_FILTERS)
        return STATUS_INSUFFICIENT_RESOURCES;

    // Create lowercase copy for WFP app ID matching
    pathBytes = (appPathChars + 1) * sizeof(WCHAR);
    lowerPath = (PWCHAR)ExAllocatePool2(POOL_FLAG_NON_PAGED, pathBytes, 'pAWd');
    if (!lowerPath)
        return STATUS_INSUFFICIENT_RESOURCES;

    RtlCopyMemory(lowerPath, appPath, appPathChars * sizeof(WCHAR));
    lowerPath[appPathChars] = L'\0';
    LowercaseWideString(lowerPath, appPathChars);

    // Build the app ID blob
    appBlob.size = pathBytes;
    appBlob.data = (UINT8*)lowerPath;

    // Build the filter condition: match this app path
    condition.fieldKey = FWPM_CONDITION_ALE_APP_ID;
    condition.matchType = FWP_MATCH_EQUAL;
    condition.conditionValue.type = FWP_BYTE_BLOB_TYPE;
    condition.conditionValue.byteBlob = &appBlob;

    // Build the filter
    wfpFilter.layerKey = *layerKey;
    wfpFilter.subLayerKey = WIREDOG_SUBLAYER;
    wfpFilter.displayData.name = L"WireDog Split Tunnel App Filter";
    wfpFilter.weight.type = FWP_UINT8;
    wfpFilter.numFilterConditions = 1;
    wfpFilter.filterCondition = &condition;

    if (isPermit) {
        // Include mode: invoke callout but skip redirect (rawContext=1 signals this).
        // FWP_ACTION_PERMIT is not supported on redirect layers — must use callout action.
        wfpFilter.action.type = FWP_ACTION_CALLOUT_UNKNOWN;
        wfpFilter.action.calloutKey = *calloutKey;
        wfpFilter.rawContext = 1;  // Signal to callout: skip redirect
        wfpFilter.weight.uint8 = WEIGHT_APP_REDIRECT;
    } else {
        // Callout filter (redirect matched apps to physical IP)
        wfpFilter.action.type = FWP_ACTION_CALLOUT_UNKNOWN;
        wfpFilter.action.calloutKey = *calloutKey;
        wfpFilter.weight.uint8 = WEIGHT_APP_REDIRECT;
    }

    KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
        "WireDogSplitTunnel: Adding app filter: pathLen=%hu, permit=%d, blobSize=%lu\n",
        appPathChars, isPermit, appBlob.size));

    status = FwpmFilterAdd0(ctx->EngineHandle, &wfpFilter, NULL, &filterId);
    if (NT_SUCCESS(status)) {
        ctx->AppFilterIds[ctx->AppFilterCount++] = filterId;
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: App filter added, id=%llu, total=%lu\n",
            filterId, ctx->AppFilterCount));
    } else {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmFilterAdd app filter failed 0x%x (permit=%d)\n",
            status, isPermit));
    }

    ExFreePoolWithTag(lowerPath, 'pAWd');
    return status;
}

/*
 * Add a catch-all callout filter (no app condition) on the specified layer.
 * Used for include mode: redirects ALL traffic, then per-app permits override.
 */
static NTSTATUS WfpAddCatchAllFilter(
    _In_ PST_DRIVER_CONTEXT ctx,
    _In_ const GUID* layerKey,
    _In_ const GUID* calloutKey)
{
    FWPM_FILTER0 wfpFilter = { 0 };
    UINT64 filterId = 0;
    NTSTATUS status;

    if (ctx->AppFilterCount >= MAX_APP_FILTERS)
        return STATUS_INSUFFICIENT_RESOURCES;

    wfpFilter.layerKey = *layerKey;
    wfpFilter.subLayerKey = WIREDOG_SUBLAYER;
    wfpFilter.displayData.name = L"WireDog Split Tunnel Catch-All Filter";
    wfpFilter.action.type = FWP_ACTION_CALLOUT_UNKNOWN;
    wfpFilter.action.calloutKey = *calloutKey;
    wfpFilter.weight.type = FWP_UINT8;
    wfpFilter.weight.uint8 = 0x0E;  // Lower weight than per-app redirect filters (0x0F)
    wfpFilter.numFilterConditions = 0;
    wfpFilter.filterCondition = NULL;

    status = FwpmFilterAdd0(ctx->EngineHandle, &wfpFilter, NULL, &filterId);
    if (NT_SUCCESS(status)) {
        ctx->AppFilterIds[ctx->AppFilterCount++] = filterId;
    } else {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmFilterAdd catch-all failed 0x%x\n", status));
    }

    return status;
}

/*
 * Add a per-app AUTH layer filter (PERMIT or BLOCK, no callout needed).
 * Used to enforce interface selection: PERMIT on physical, BLOCK on everything else.
 *
 * For PERMIT: conditions = app_id AND interface_index = physicalIfIndex
 * For BLOCK:  conditions = app_id only (catches all interfaces including tunnel)
 *
 * PERMIT has higher weight than BLOCK, so for physical interface traffic
 * the PERMIT wins. For tunnel interface traffic, only the BLOCK matches.
 */
static NTSTATUS WfpAddAppAuthFilter(
    _In_ PST_DRIVER_CONTEXT ctx,
    _In_ const WCHAR* appPath,
    _In_ USHORT appPathChars,
    _In_ const GUID* layerKey,
    _In_ BOOLEAN isPermit,
    _In_ ULONG ifIndex)  // Interface index for PERMIT condition (0 = no interface condition)
{
    NTSTATUS status;
    FWPM_FILTER0 wfpFilter = { 0 };
    FWPM_FILTER_CONDITION0 conditions[2] = { 0 };
    FWP_BYTE_BLOB appBlob = { 0 };
    UINT64 filterId = 0;
    PWCHAR lowerPath = NULL;
    ULONG pathBytes;

    if (ctx->AppFilterCount >= MAX_APP_FILTERS)
        return STATUS_INSUFFICIENT_RESOURCES;

    // Create lowercase copy for WFP app ID matching
    pathBytes = (appPathChars + 1) * sizeof(WCHAR);
    lowerPath = (PWCHAR)ExAllocatePool2(POOL_FLAG_NON_PAGED, pathBytes, 'pAWd');
    if (!lowerPath)
        return STATUS_INSUFFICIENT_RESOURCES;

    RtlCopyMemory(lowerPath, appPath, appPathChars * sizeof(WCHAR));
    lowerPath[appPathChars] = L'\0';
    LowercaseWideString(lowerPath, appPathChars);

    appBlob.size = pathBytes;
    appBlob.data = (UINT8*)lowerPath;

    // Condition 0: match app path
    conditions[0].fieldKey = FWPM_CONDITION_ALE_APP_ID;
    conditions[0].matchType = FWP_MATCH_EQUAL;
    conditions[0].conditionValue.type = FWP_BYTE_BLOB_TYPE;
    conditions[0].conditionValue.byteBlob = &appBlob;

    wfpFilter.layerKey = *layerKey;
    wfpFilter.subLayerKey = WIREDOG_SUBLAYER;
    wfpFilter.filterCondition = conditions;

    if (isPermit) {
        wfpFilter.action.type = FWP_ACTION_PERMIT;
        // CLEAR_ACTION_RIGHT: prevents lower-weight sublayers (e.g. Windows Firewall)
        // from overriding our PERMIT with their BLOCK filters
        wfpFilter.flags = FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT;
        wfpFilter.weight.type = FWP_UINT8;
        wfpFilter.weight.uint8 = WEIGHT_APP_AUTH_PERMIT;

        if (ifIndex != 0) {
            // PERMIT: app + specific interface (exclude mode: physical if, include mode: tunnel if)
            conditions[1].fieldKey = FWPM_CONDITION_INTERFACE_INDEX;
            conditions[1].matchType = FWP_MATCH_EQUAL;
            conditions[1].conditionValue.type = FWP_UINT32;
            conditions[1].conditionValue.uint32 = ifIndex;
            wfpFilter.numFilterConditions = 2;
            wfpFilter.displayData.name = L"WireDog Auth Permit (Interface)";
        } else {
            // PERMIT: app only (for AUTH_RECV_ACCEPT — INTERFACE_INDEX not reliable)
            wfpFilter.numFilterConditions = 1;
            wfpFilter.displayData.name = L"WireDog Auth Permit (App)";
        }
    } else {
        // BLOCK: app only (catches all interfaces including tunnel)
        wfpFilter.numFilterConditions = 1;
        wfpFilter.action.type = FWP_ACTION_BLOCK;
        wfpFilter.weight.type = FWP_UINT8;
        wfpFilter.weight.uint8 = WEIGHT_APP_AUTH_BLOCK;
        wfpFilter.displayData.name = L"WireDog Auth Block";
    }

    status = FwpmFilterAdd0(ctx->EngineHandle, &wfpFilter, NULL, &filterId);
    if (NT_SUCCESS(status)) {
        ctx->AppFilterIds[ctx->AppFilterCount++] = filterId;
    } else {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmFilterAdd auth filter failed 0x%x (permit=%d)\n",
            status, isPermit));
    }

    ExFreePoolWithTag(lowerPath, 'pAWd');
    return status;
}

/*
 * Create per-app WFP filters based on configured apps and mode.
 *
 * Exclude mode: Per-app CALLOUT filters for each app (only excluded apps hit callout).
 * Include mode: Catch-all CALLOUT filter + per-app PERMIT filters (included apps skip callout).
 *
 * Must be called after WfpInitialize and after configuration is set.
 */
NTSTATUS WfpAddAppFilters(_In_ PST_DRIVER_CONTEXT ctx)
{
    KIRQL oldIrql;
    ULONG mode, appCount, i;
    NTSTATUS status = STATUS_SUCCESS;
    BOOLEAN inTransaction = FALSE;

    // Layer/callout pairs for the 4 redirect layers
    static const struct {
        const GUID* layerKey;
        const GUID* calloutKey;
    } layers[] = {
        { &FWPM_LAYER_ALE_BIND_REDIRECT_V4,    &WIREDOG_CALLOUT_V4 },
        { &FWPM_LAYER_ALE_BIND_REDIRECT_V6,    &WIREDOG_CALLOUT_V6 },
        { &FWPM_LAYER_ALE_CONNECT_REDIRECT_V4,  &WIREDOG_CONNECT_CALLOUT_V4 },
        { &FWPM_LAYER_ALE_CONNECT_REDIRECT_V6,  &WIREDOG_CONNECT_CALLOUT_V6 },
    };

    if (!ctx->EngineHandle) return STATUS_INVALID_DEVICE_STATE;

    // Remove any existing app filters first
    WfpRemoveAppFilters(ctx);

    KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
    mode = ctx->Mode;
    appCount = ctx->AppCount;
    KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);

    if (appCount == 0) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: No apps configured, no filters added\n"));
        return STATUS_SUCCESS;
    }

    // Start a WFP transaction so all filters are added atomically.
    // If any filter fails, the transaction is aborted and no filters are created.
    status = FwpmTransactionBegin0(ctx->EngineHandle, 0);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmTransactionBegin failed 0x%x\n", status));
        return status;
    }
    inTransaction = TRUE;

    // Note: No spinlock needed here — the IOCTL handler runs on a sequential queue,
    // so config data is stable. WFP management APIs (FwpmFilterAdd0) require PASSIVE_LEVEL
    // and MUST NOT be called while holding a spinlock (DISPATCH_LEVEL).

    if (mode == ST_MODE_INCLUDE) {
        // Include mode: catch-all callout filter on each layer (redirects everything
        // to physical IP) + per-app callout filters at higher weight with rawContext=1
        // (callout skips redirect, so included apps stay on VPN via default /1 routes)
        ULONG layerIdx;
        for (layerIdx = 0; layerIdx < 4; layerIdx++) {
            status = WfpAddCatchAllFilter(ctx, layers[layerIdx].layerKey, layers[layerIdx].calloutKey);
            if (!NT_SUCCESS(status)) goto cleanup;
        }

        // Per-app callout filters for included apps (rawContext=1 → callout skips redirect)
        for (i = 0; i < appCount; i++) {
            USHORT pathLen = (USHORT)wcslen(ctx->Apps[i].Path);
            ULONG layerIdx2;

            if (pathLen == 0) continue;

            for (layerIdx2 = 0; layerIdx2 < 4; layerIdx2++) {
                status = WfpAddSingleAppFilter(ctx, ctx->Apps[i].Path, pathLen,
                    layers[layerIdx2].layerKey, layers[layerIdx2].calloutKey, TRUE);
                if (!NT_SUCCESS(status)) goto cleanup;
            }

            // AUTH_CONNECT: per-app PERMIT on tunnel interface (V4 + V6)
            // Included apps can only connect through the tunnel interface.
            // The catch-all BLOCK below handles non-included apps' V6.
            status = WfpAddAppAuthFilter(ctx, ctx->Apps[i].Path, pathLen,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V4, TRUE, ctx->TunnelInterfaceIndex);
            if (!NT_SUCCESS(status)) goto cleanup;

            status = WfpAddAppAuthFilter(ctx, ctx->Apps[i].Path, pathLen,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V6, TRUE, ctx->TunnelInterfaceIndex);
            if (!NT_SUCCESS(status)) goto cleanup;

            // AUTH_RECV_ACCEPT: per-app PERMIT (app only, no interface condition)
            // Allows included apps to receive response traffic on any interface.
            // INTERFACE_INDEX is not reliably available at AUTH_RECV_ACCEPT for IPv6.
            status = WfpAddAppAuthFilter(ctx, ctx->Apps[i].Path, pathLen,
                &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, TRUE, 0);
            if (!NT_SUCCESS(status)) goto cleanup;

            status = WfpAddAppAuthFilter(ctx, ctx->Apps[i].Path, pathLen,
                &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6, TRUE, 0);
            if (!NT_SUCCESS(status)) goto cleanup;
        }

        // Catch-all BLOCK on AUTH_CONNECT_V6: blocks non-included apps' IPv6.
        // IPv6 weak host model + WireGuard ::/1 routes would capture non-included traffic.
        // When WFP blocks at AUTH_CONNECT, Windows retries the next route (physical).
        // Included apps have per-app PERMIT on tunnel if (weight WEIGHT_APP_AUTH_PERMIT) which overrides.
        {
            FWPM_FILTER0 blockFilter = { 0 };
            UINT64 blockFilterId = 0;

            if (ctx->AppFilterCount >= MAX_APP_FILTERS) {
                status = STATUS_INSUFFICIENT_RESOURCES;
                goto cleanup;
            }

            blockFilter.layerKey = FWPM_LAYER_ALE_AUTH_CONNECT_V6;
            blockFilter.subLayerKey = WIREDOG_SUBLAYER;
            blockFilter.action.type = FWP_ACTION_BLOCK;
            blockFilter.weight.type = FWP_UINT8;
            blockFilter.weight.uint8 = WEIGHT_CATCHALL_BLOCK;
            blockFilter.numFilterConditions = 0;
            blockFilter.displayData.name = L"WireDog IPv6 Block (Non-Included)";

            status = FwpmFilterAdd0(ctx->EngineHandle, &blockFilter, NULL, &blockFilterId);
            if (!NT_SUCCESS(status)) {
                KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
                    "WireDogSplitTunnel: Failed to add IPv6 catch-all BLOCK (include) 0x%x\n", status));
                goto cleanup;
            }
            ctx->AppFilterIds[ctx->AppFilterCount++] = blockFilterId;
        }
    } else {
        // Exclude mode: per-app CALLOUT filters for excluded apps (redirect to physical IP)
        // + AUTH layer BLOCK/PERMIT filters to enforce interface selection

        // AUTH_CONNECT layers: PERMIT on physical + BLOCK on all (interface selection)
        static const GUID* authConnectLayers[] = {
            &FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
        };

        // AUTH_RECV_ACCEPT layers: PERMIT only (app-only, no interface condition).
        // INTERFACE_INDEX is not reliably resolved at AUTH_RECV_ACCEPT for IPv6,
        // so we use an unconditional per-app PERMIT to override external BLOCKs.
        static const GUID* authRecvLayers[] = {
            &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
            &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
        };

        for (i = 0; i < appCount; i++) {
            USHORT pathLen = (USHORT)wcslen(ctx->Apps[i].Path);
            ULONG layerIdx2;

            if (pathLen == 0) continue;

            // Redirect filters (bind + connect redirect on 4 layers)
            for (layerIdx2 = 0; layerIdx2 < 4; layerIdx2++) {
                status = WfpAddSingleAppFilter(ctx, ctx->Apps[i].Path, pathLen,
                    layers[layerIdx2].layerKey, layers[layerIdx2].calloutKey, FALSE);
                if (!NT_SUCCESS(status)) goto cleanup;
            }

            // AUTH_CONNECT: PERMIT on physical interface (V4 + V6) + per-app BLOCK on V4.
            // For V4: per-app PERMIT (physical if) wins over per-app BLOCK when on physical.
            //         If somehow routed to tunnel, BLOCK fires → Windows retries on physical.
            // For V6: per-app PERMIT (physical if) + catch-all BLOCK below handle routing.
            //         IPv6 ::/1 routes are stripped so non-excluded apps have no V6 tunnel route.
            for (layerIdx2 = 0; layerIdx2 < 2; layerIdx2++) {
                // PERMIT: app + physical interface (higher weight, wins on physical)
                status = WfpAddAppAuthFilter(ctx, ctx->Apps[i].Path, pathLen,
                    authConnectLayers[layerIdx2], TRUE, ctx->PhysicalInterfaceIndex);
                if (!NT_SUCCESS(status)) goto cleanup;

                // BLOCK: app only — IPv4 only (layerIdx2==0).
                // Skip for IPv6 (layerIdx2==1) — IPv6 uses catch-all BLOCK + stripped ::/1 routes.
                if (layerIdx2 == 0) {
                    status = WfpAddAppAuthFilter(ctx, ctx->Apps[i].Path, pathLen,
                        authConnectLayers[layerIdx2], FALSE, 0);
                    if (!NT_SUCCESS(status)) goto cleanup;
                }
            }

            // AUTH_RECV_ACCEPT: Per-app PERMIT only (no interface condition).
            // At this layer, INTERFACE_INDEX may not be resolved for IPv6 responses.
            // A simple per-app PERMIT with CLEAR_ACTION_RIGHT overrides any external
            // BLOCK (e.g., Windows Firewall) and allows the excluded app to receive
            // response traffic on any interface.
            for (layerIdx2 = 0; layerIdx2 < 2; layerIdx2++) {
                status = WfpAddAppAuthFilter(ctx, ctx->Apps[i].Path, pathLen,
                    authRecvLayers[layerIdx2], TRUE, 0);
                if (!NT_SUCCESS(status)) goto cleanup;
            }
        }

        // Catch-all BLOCK on AUTH_CONNECT_V6: prevents non-excluded apps from using IPv6.
        // WireGuard ::/1 routes are stripped from AllowedIPs, so non-excluded apps have no
        // IPv6 tunnel route. The catch-all BLOCK prevents IPv6 leaks through the physical adapter.
        // Excluded apps have per-app PERMIT (WEIGHT_APP_AUTH_PERMIT) which overrides this BLOCK.
        {
            FWPM_FILTER0 blockFilter = { 0 };
            UINT64 blockFilterId = 0;

            if (ctx->AppFilterCount >= MAX_APP_FILTERS) {
                status = STATUS_INSUFFICIENT_RESOURCES;
                goto cleanup;
            }

            blockFilter.layerKey = FWPM_LAYER_ALE_AUTH_CONNECT_V6;
            blockFilter.subLayerKey = WIREDOG_SUBLAYER;
            blockFilter.action.type = FWP_ACTION_BLOCK;
            blockFilter.weight.type = FWP_UINT8;
            blockFilter.weight.uint8 = WEIGHT_CATCHALL_BLOCK;
            blockFilter.numFilterConditions = 0;  // Catch-all: no conditions
            blockFilter.displayData.name = L"WireDog IPv6 Block (Non-Excluded)";

            status = FwpmFilterAdd0(ctx->EngineHandle, &blockFilter, NULL, &blockFilterId);
            if (!NT_SUCCESS(status)) {
                KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
                    "WireDogSplitTunnel: Failed to add IPv6 catch-all BLOCK 0x%x\n", status));
                goto cleanup;
            }
            ctx->AppFilterIds[ctx->AppFilterCount++] = blockFilterId;

            KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
                "WireDogSplitTunnel: Added IPv6 catch-all BLOCK on AUTH_CONNECT_V6 (id=%llu)\n",
                blockFilterId));
        }
    }

    // Commit the transaction — all filters become active atomically
    status = FwpmTransactionCommit0(ctx->EngineHandle);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: FwpmTransactionCommit failed 0x%x\n", status));
        // Transaction failed to commit — filters were not applied.
        // Clear our local tracking since WFP rolled back.
        ctx->AppFilterCount = 0;
        return status;
    }

    KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
        "WireDogSplitTunnel: Added %lu app filters (mode=%s, apps=%lu)\n",
        ctx->AppFilterCount, mode == ST_MODE_INCLUDE ? "include" : "exclude", appCount));

    return STATUS_SUCCESS;

cleanup:
    if (inTransaction) {
        FwpmTransactionAbort0(ctx->EngineHandle);
    }
    // Clear local filter tracking — transaction abort rolled back all filter adds
    ctx->AppFilterCount = 0;
    return status;
}

/*
 * Remove all per-app WFP filters.
 */
VOID WfpRemoveAppFilters(_In_ PST_DRIVER_CONTEXT ctx)
{
    ULONG i;

    if (!ctx->EngineHandle || ctx->AppFilterCount == 0)
        return;

    for (i = 0; i < ctx->AppFilterCount; i++) {
        if (ctx->AppFilterIds[i] != 0) {
            FwpmFilterDeleteById0(ctx->EngineHandle, ctx->AppFilterIds[i]);
            ctx->AppFilterIds[i] = 0;
        }
    }

    KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
        "WireDogSplitTunnel: Removed %lu app filters\n", ctx->AppFilterCount));

    ctx->AppFilterCount = 0;
}
