/*
 * WireDog Split Tunnel Driver - Main Entry
 *
 * KMDF non-PnP driver that uses WFP ALE_BIND_REDIRECT to implement
 * per-app split tunneling. Redirects socket binds to either the
 * VPN tunnel adapter or physical adapter based on app configuration.
 */

#include "common.h"

#ifdef ALLOC_PRAGMA
#pragma alloc_text(INIT, DriverEntry)
#endif

// Global context pointer (for process notify callback which has no context param)
PST_DRIVER_CONTEXT g_DriverContext = NULL;

/*
 * EvtDriverUnload - Called when the driver is stopped/unloaded
 *
 * Without this callback, the driver is marked NOT_STOPPABLE.
 */
VOID EvtDriverUnload(_In_ WDFDRIVER Driver)
{
    UNREFERENCED_PARAMETER(Driver);

    KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
        "WireDogSplitTunnel: EvtDriverUnload\n"));

    if (g_DriverContext && g_DriverContext->Initialized) {
        WfpUninitialize(g_DriverContext);
        g_DriverContext->Initialized = FALSE;
    }

    g_DriverContext = NULL;
}

/*
 * DriverEntry - Driver initialization
 *
 * For non-PnP KMDF drivers, we create the control device directly here
 * (EvtDeviceAdd is NOT called for non-PnP drivers).
 */
NTSTATUS DriverEntry(
    _In_ PDRIVER_OBJECT  DriverObject,
    _In_ PUNICODE_STRING RegistryPath)
{
    NTSTATUS status;
    WDF_DRIVER_CONFIG config;
    WDFDRIVER driver;
    PWDFDEVICE_INIT deviceInit = NULL;
    WDFDEVICE device;
    WDF_OBJECT_ATTRIBUTES deviceAttributes;
    WDF_IO_QUEUE_CONFIG queueConfig;
    WDFQUEUE queue;
    DECLARE_CONST_UNICODE_STRING(deviceName, DEVICE_NAME);
    DECLARE_CONST_UNICODE_STRING(symlinkName, SYMLINK_NAME);

    KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
        "WireDogSplitTunnel: DriverEntry\n"));

    // Create KMDF driver object (no EvtDeviceAdd for non-PnP)
    WDF_DRIVER_CONFIG_INIT(&config, WDF_NO_EVENT_CALLBACK);
    config.DriverInitFlags = WdfDriverInitNonPnpDriver;
    config.EvtDriverUnload = EvtDriverUnload;

    status = WdfDriverCreate(DriverObject, RegistryPath,
        WDF_NO_OBJECT_ATTRIBUTES, &config, &driver);

    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: WdfDriverCreate failed 0x%x\n", status));
        return status;
    }

    // Allocate control device init structure
    // SDDL: System=All, Admin=RWX
    DECLARE_CONST_UNICODE_STRING(sddlString, L"D:P(A;;GA;;;SY)(A;;GRGWGX;;;BA)");
    deviceInit = WdfControlDeviceInitAllocate(driver, &sddlString);
    if (deviceInit == NULL) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: WdfControlDeviceInitAllocate failed\n"));
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    // Configure control device
    WdfDeviceInitSetDeviceType(deviceInit, FILE_DEVICE_UNKNOWN);
    WdfDeviceInitSetCharacteristics(deviceInit, FILE_DEVICE_SECURE_OPEN, FALSE);
    WdfDeviceInitSetExclusive(deviceInit, FALSE);

    status = WdfDeviceInitAssignName(deviceInit, &deviceName);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: AssignName failed 0x%x\n", status));
        WdfDeviceInitFree(deviceInit);
        return status;
    }

    // Create the device with driver context
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&deviceAttributes, ST_DRIVER_CONTEXT);

    status = WdfDeviceCreate(&deviceInit, &deviceAttributes, &device);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: WdfDeviceCreate failed 0x%x\n", status));
        // deviceInit is freed by WdfDeviceCreate on failure
        return status;
    }

    // Create symbolic link for user-mode access (\\.\WireDogSplitTunnel)
    status = WdfDeviceCreateSymbolicLink(device, &symlinkName);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: CreateSymbolicLink failed 0x%x\n", status));
        return status;
    }

    // Initialize driver context
    PST_DRIVER_CONTEXT ctx = GetDriverContext(device);
    RtlZeroMemory(ctx, sizeof(ST_DRIVER_CONTEXT));
    ctx->Device = device;
    KeInitializeSpinLock(&ctx->ConfigLock);
    g_DriverContext = ctx;

    // Create default IO queue for IOCTL handling
    WDF_IO_QUEUE_CONFIG_INIT_DEFAULT_QUEUE(&queueConfig, WdfIoQueueDispatchSequential);
    queueConfig.EvtIoDeviceControl = EvtIoDeviceControl;

    status = WdfIoQueueCreate(device, &queueConfig, WDF_NO_OBJECT_ATTRIBUTES, &queue);
    if (!NT_SUCCESS(status)) {
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
            "WireDogSplitTunnel: WdfIoQueueCreate failed 0x%x\n", status));
        return status;
    }

    // Finish initializing the control device — makes it accessible to user-mode
    WdfControlFinishInitializing(device);

    KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
        "WireDogSplitTunnel: Device created successfully\n"));

    return STATUS_SUCCESS;
}

/*
 * EvtIoDeviceControl - Handle IOCTLs from user-mode service
 */
VOID EvtIoDeviceControl(
    _In_ WDFQUEUE Queue,
    _In_ WDFREQUEST Request,
    _In_ size_t OutputBufferLength,
    _In_ size_t InputBufferLength,
    _In_ ULONG IoControlCode)
{
    NTSTATUS status = STATUS_SUCCESS;
    WDFDEVICE device = WdfIoQueueGetDevice(Queue);
    PST_DRIVER_CONTEXT ctx = GetDriverContext(device);
    PVOID inputBuffer = NULL;
    PVOID outputBuffer = NULL;
    size_t bytesReturned = 0;
    KIRQL oldIrql;

    switch (IoControlCode) {

    case IOCTL_ST_INITIALIZE:
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: IOCTL_ST_INITIALIZE\n"));

        if (ctx->Initialized) {
            status = STATUS_SUCCESS;
            break;
        }

        // Initialize WFP callouts (no filters yet — added by SET_CONFIGURATION)
        status = WfpInitialize(ctx);
        if (!NT_SUCCESS(status)) {
            KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
                "WireDogSplitTunnel: WfpInitialize failed 0x%x\n", status));
            break;
        }

        KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
        ctx->Initialized = TRUE;
        KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);

        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: Initialized successfully\n"));
        break;

    case IOCTL_ST_SET_CONFIGURATION:
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: IOCTL_ST_SET_CONFIGURATION\n"));

        if (InputBufferLength < sizeof(ST_CONFIGURATION)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }

        status = WdfRequestRetrieveInputBuffer(Request, sizeof(ST_CONFIGURATION),
            &inputBuffer, NULL);
        if (!NT_SUCCESS(status)) break;

        {
            PST_CONFIGURATION config2 = (PST_CONFIGURATION)inputBuffer;

            if (config2->AppCount > MAX_APPS) {
                status = STATUS_INVALID_PARAMETER;
                break;
            }

            KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
            ctx->Mode = config2->Mode;
            ctx->AppCount = config2->AppCount;
            RtlCopyMemory(ctx->Apps, config2->Apps,
                config2->AppCount * sizeof(ST_APP_ENTRY));
            KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);

            KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
                "WireDogSplitTunnel: Configuration set: mode=%lu, apps=%lu\n",
                config2->Mode, config2->AppCount));

            // Create per-app WFP filters for the configured apps
            if (config2->AppCount > 0 && ctx->Initialized) {
                status = WfpAddAppFilters(ctx);
                if (!NT_SUCCESS(status)) {
                    KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_ERROR_LEVEL,
                        "WireDogSplitTunnel: WfpAddAppFilters failed 0x%x\n", status));
                }
            }
        }
        break;

    case IOCTL_ST_REGISTER_IPS:
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: IOCTL_ST_REGISTER_IPS\n"));

        if (InputBufferLength < sizeof(ST_IP_ADDRESSES)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }

        status = WdfRequestRetrieveInputBuffer(Request, sizeof(ST_IP_ADDRESSES),
            &inputBuffer, NULL);
        if (!NT_SUCCESS(status)) break;

        {
            PST_IP_ADDRESSES ips = (PST_IP_ADDRESSES)inputBuffer;

            KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
            ctx->TunnelIpV4 = ips->TunnelIpV4;
            ctx->PhysicalIpV4 = ips->PhysicalIpV4;
            RtlCopyMemory(ctx->TunnelIpV6, ips->TunnelIpV6, 16);
            RtlCopyMemory(ctx->PhysicalIpV6, ips->PhysicalIpV6, 16);
            ctx->HasV6 = ips->HasV6;
            ctx->PhysicalInterfaceIndex = ips->PhysicalInterfaceIndex;
            ctx->TunnelInterfaceIndex = ips->TunnelInterfaceIndex;
            ctx->IpRegistered = TRUE;
            KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);
        }

        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: IP addresses registered (hasV6=%d, physIf=%lu)\n",
            ctx->HasV6, ctx->PhysicalInterfaceIndex));
        break;

    case IOCTL_ST_GET_STATE:
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: IOCTL_ST_GET_STATE\n"));

        if (OutputBufferLength < sizeof(ST_STATE)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }

        status = WdfRequestRetrieveOutputBuffer(Request, sizeof(ST_STATE),
            &outputBuffer, NULL);
        if (!NT_SUCCESS(status)) break;

        {
            PST_STATE state = (PST_STATE)outputBuffer;

            KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
            state->Initialized = ctx->Initialized;
            state->Mode = ctx->Mode;
            state->AppCount = ctx->AppCount;
            KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);

            state->ActiveFilterCount = ctx->AppFilterCount;
            state->ClassifyCallCount = (ULONG)ctx->ClassifyCallCount;
            state->ClassifyMatchCount = (ULONG)ctx->ClassifyMatchCount;
            state->RedirectSuccessCount = (ULONG)ctx->RedirectSuccessCount;
            state->RedirectErrorCount = (ULONG)ctx->RedirectErrorCount;
            state->ClassifyCallCountV6 = (ULONG)ctx->ClassifyCallCountV6;
            state->ClassifyMatchCountV6 = (ULONG)ctx->ClassifyMatchCountV6;
            state->RedirectSuccessCountV6 = (ULONG)ctx->RedirectSuccessCountV6;
            state->RedirectErrorCountV6 = (ULONG)ctx->RedirectErrorCountV6;

            bytesReturned = sizeof(ST_STATE);
        }
        break;

    case IOCTL_ST_CLEAR_CONFIGURATION:
        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: IOCTL_ST_CLEAR_CONFIGURATION\n"));

        if (ctx->Initialized) {
            WfpUninitialize(ctx);
        }

        KeAcquireSpinLock(&ctx->ConfigLock, &oldIrql);
        ctx->Initialized = FALSE;
        ctx->Mode = ST_MODE_EXCLUDE;
        ctx->AppCount = 0;
        ctx->IpRegistered = FALSE;
        RtlZeroMemory(ctx->Apps, sizeof(ctx->Apps));
        KeReleaseSpinLock(&ctx->ConfigLock, oldIrql);

        // Reset diagnostic counters so next connection starts clean
        InterlockedExchange(&ctx->ClassifyCallCount, 0);
        InterlockedExchange(&ctx->ClassifyMatchCount, 0);
        InterlockedExchange(&ctx->RedirectSuccessCount, 0);
        InterlockedExchange(&ctx->RedirectErrorCount, 0);
        InterlockedExchange(&ctx->ClassifyCallCountV6, 0);
        InterlockedExchange(&ctx->ClassifyMatchCountV6, 0);
        InterlockedExchange(&ctx->RedirectSuccessCountV6, 0);
        InterlockedExchange(&ctx->RedirectErrorCountV6, 0);

        KdPrintEx((DPFLTR_IHVNETWORK_ID, DPFLTR_INFO_LEVEL,
            "WireDogSplitTunnel: Configuration cleared\n"));
        break;

    default:
        status = STATUS_INVALID_DEVICE_REQUEST;
        break;
    }

    WdfRequestCompleteWithInformation(Request, status, bytesReturned);
}
