using WireDog.Service.Native;
using System.Diagnostics;

namespace WireDog.Service.Tunnel;

/// <summary>
/// Manages the child AmneziaWGTunnel$WireDog Windows service
/// </summary>
public class TunnelServiceManager : IDisposable
{
    private readonly ILogger<TunnelServiceManager> _logger;
    private readonly string _serviceName = "AmneziaWGTunnel$WireDog";
    private readonly string _serviceDisplayName = "WireDog VPN Tunnel";
    private bool _disposed;

    public TunnelServiceManager(ILogger<TunnelServiceManager> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Install and start the tunnel service
    /// </summary>
    public bool InstallAndStart(string configPath)
    {
        try
        {
            // Get path to current service executable
            var servicePath = Process.GetCurrentProcess().MainModule?.FileName;
            if (string.IsNullOrEmpty(servicePath))
            {
                _logger.LogError("Could not determine service executable path");
                return false;
            }

            // Stop and remove existing service if present. Stop() itself waits for the SCM
            // to confirm full removal, so no extra fixed delay is needed here.
            if (!Stop())
            {
                _logger.LogWarning("Previous tunnel service instance did not fully clean up; attempting to create anyway");
            }

            // Create service
            var scmHandle = ServiceControlManager.OpenSCManager(null, null, ServiceControlManager.ScmAccessRights.AllAccess);
            if (scmHandle == IntPtr.Zero)
            {
                _logger.LogError("Failed to open Service Control Manager");
                return false;
            }

            try
            {
                // Build command line: "path\to\service.exe /tunnel config_path"
                var binaryPath = $"\"{servicePath}\" /tunnel \"{configPath}\"";

                // Create the service. Retry on ERROR_SERVICE_MARKED_FOR_DELETE (1072): the
                // previous instance can still be draining even after Stop()'s own wait.
                const int ErrorServiceMarkedForDelete = 1072;
                IntPtr serviceHandle;
                var attempt = 0;
                while (true)
                {
                    serviceHandle = ServiceControlManager.CreateService(
                        scmHandle,
                        _serviceName,
                        _serviceDisplayName,
                        ServiceControlManager.ServiceAccessRights.AllAccess,
                        ServiceControlManager.ServiceType.Win32OwnProcess,
                        ServiceControlManager.ServiceStartType.Demand,
                        ServiceControlManager.ServiceError.Normal,
                        binaryPath,
                        null,
                        IntPtr.Zero,
                        "Nsi\0TcpIp\0\0",  // Dependencies
                        null,
                        null);

                    if (serviceHandle != IntPtr.Zero)
                    {
                        break;
                    }

                    var error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                    attempt++;
                    if (error == ErrorServiceMarkedForDelete && attempt < 5)
                    {
                        _logger.LogWarning("CreateService hit ERROR_SERVICE_MARKED_FOR_DELETE, retrying ({Attempt}/5)", attempt);
                        System.Threading.Thread.Sleep(500);
                        continue;
                    }

                    _logger.LogError("Failed to create service. Error: {Error}", error);
                    return false;
                }

                try
                {
                    // Set SERVICE_SID_TYPE_UNRESTRICTED - CRITICAL!
                    var sidInfo = new ServiceControlManager.ServiceSidInfo { serviceSidType = ServiceControlManager.ServiceSidType.Unrestricted };
                    if (!ServiceControlManager.ChangeServiceConfig2(serviceHandle, ServiceControlManager.ServiceConfigType.SidInfo, ref sidInfo))
                    {
                        var error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                        _logger.LogError("Failed to set service SID type. Error: {Error}", error);
                        ServiceControlManager.DeleteService(serviceHandle);
                        return false;
                    }

                    // Set service description
                    var desc = new ServiceControlManager.ServiceDescription { lpDescription = "WireDog VPN tunnel service using WireGuard protocol" };
                    ServiceControlManager.ChangeServiceConfig2(serviceHandle, ServiceControlManager.ServiceConfigType.Description, ref desc);

                    _logger.LogInformation("Service created: {ServiceName}", _serviceName);

                    // Start the service
                    if (!ServiceControlManager.StartService(serviceHandle, 0, null))
                    {
                        var error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                        _logger.LogError("Failed to start service. Error: {Error}", error);
                        ServiceControlManager.DeleteService(serviceHandle);
                        return false;
                    }

                    _logger.LogInformation("Service started: {ServiceName}", _serviceName);
                    return true;
                }
                finally
                {
                    ServiceControlManager.CloseServiceHandle(serviceHandle);
                }
            }
            finally
            {
                ServiceControlManager.CloseServiceHandle(scmHandle);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exception creating/starting tunnel service");
            return false;
        }
    }

    /// <summary>
    /// Check whether the tunnel service is currently in Running state.
    /// Also returns exit codes (via out params) when the service is stopped.
    /// </summary>
    public bool IsRunning(out int win32ExitCode, out int serviceExitCode)
    {
        win32ExitCode = 0;
        serviceExitCode = 0;
        try
        {
            var scmHandle = ServiceControlManager.OpenSCManager(null, null, ServiceControlManager.ScmAccessRights.AllAccess);
            if (scmHandle == IntPtr.Zero) return false;
            try
            {
                var serviceHandle = ServiceControlManager.OpenService(scmHandle, _serviceName, ServiceControlManager.ServiceAccessRights.AllAccess);
                if (serviceHandle == IntPtr.Zero) return false;
                try
                {
                    var status = new ServiceControlManager.ServiceStatus();
                    if (!ServiceControlManager.QueryServiceStatus(serviceHandle, status)) return false;
                    win32ExitCode = status.dwWin32ExitCode;
                    serviceExitCode = status.dwServiceSpecificExitCode;
                    return status.dwCurrentState == ServiceControlManager.ServiceState.Running;
                }
                finally { ServiceControlManager.CloseServiceHandle(serviceHandle); }
            }
            finally { ServiceControlManager.CloseServiceHandle(scmHandle); }
        }
        catch { return false; }
    }

    /// <summary>
    /// Check whether the tunnel service is currently in Running state
    /// </summary>
    public bool IsRunning() => IsRunning(out _, out _);

    /// <summary>
    /// Stop and remove the tunnel service
    /// </summary>
    public bool Stop()
    {
        try
        {
            var scmHandle = ServiceControlManager.OpenSCManager(null, null, ServiceControlManager.ScmAccessRights.AllAccess);
            if (scmHandle == IntPtr.Zero)
            {
                return false;
            }

            try
            {
                var serviceHandle = ServiceControlManager.OpenService(scmHandle, _serviceName, ServiceControlManager.ServiceAccessRights.AllAccess);
                if (serviceHandle == IntPtr.Zero)
                {
                    // Service doesn't exist, that's fine
                    return true;
                }

                try
                {
                    // Stop the service
                    var status = new ServiceControlManager.ServiceStatus();
                    ServiceControlManager.ControlService(serviceHandle, ServiceControlManager.ServiceControl.Stop, status);

                    // Wait for service to stop
                    for (int i = 0; i < 10; i++)
                    {
                        if (ServiceControlManager.QueryServiceStatus(serviceHandle, status))
                        {
                            if (status.dwCurrentState == ServiceControlManager.ServiceState.Stopped)
                            {
                                break;
                            }
                        }
                        System.Threading.Thread.Sleep(100);
                    }

                    // Delete the service. This only marks it for deletion — the SCM won't
                    // actually purge it until every handle (including the exiting child
                    // process) is released, so a failure here isn't necessarily fatal.
                    if (!ServiceControlManager.DeleteService(serviceHandle))
                    {
                        var error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                        _logger.LogWarning("Failed to delete service. Error: {Error}", error);
                    }
                }
                finally
                {
                    ServiceControlManager.CloseServiceHandle(serviceHandle);
                }

                // DeleteService is fire-and-forget — poll until the SCM confirms the service
                // is actually gone, otherwise a subsequent CreateService can fail with
                // ERROR_SERVICE_MARKED_FOR_DELETE (1072) while the previous instance drains.
                if (!WaitUntilFullyRemoved(scmHandle, 5000))
                {
                    _logger.LogWarning("Service {ServiceName} still marked for deletion after waiting", _serviceName);
                    return false;
                }

                _logger.LogInformation("Service stopped and deleted: {ServiceName}", _serviceName);
                return true;
            }
            finally
            {
                ServiceControlManager.CloseServiceHandle(scmHandle);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exception stopping tunnel service");
            return false;
        }
    }

    /// <summary>
    /// Poll until the SCM confirms _serviceName no longer exists at all. DeleteService
    /// only flags a service for removal; the SCM keeps it (in a "marked for delete" state)
    /// until every open handle — including the still-exiting child process — is released.
    /// </summary>
    private bool WaitUntilFullyRemoved(IntPtr scmHandle, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        do
        {
            var handle = ServiceControlManager.OpenService(scmHandle, _serviceName, ServiceControlManager.ServiceAccessRights.QueryStatus);
            if (handle == IntPtr.Zero)
            {
                return true;
            }
            ServiceControlManager.CloseServiceHandle(handle);
            System.Threading.Thread.Sleep(200);
        } while (Environment.TickCount64 < deadline);

        return false;
    }

    public void Dispose()
    {
        if (_disposed)
            return;

        Stop();
        _disposed = true;
    }
}
