using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace WireDog.Service.Ipc;

/// <summary>
/// Named Pipe server for IPC with Electron GUI
/// </summary>
public class NamedPipeServer
{
    private readonly ILogger<NamedPipeServer> _logger;
    private readonly JsonRpcHandler _handler;
    private readonly ServiceConfiguration _config;
    private readonly List<ClientConnection> _clients = new();
    private readonly object _clientsLock = new();
    private CancellationTokenSource? _cts;
    private Task? _acceptTask;

    public NamedPipeServer(
        ILogger<NamedPipeServer> logger,
        JsonRpcHandler handler,
        ServiceConfiguration config)
    {
        _logger = logger;
        _handler = handler;
        _config = config;

        // Subscribe to notifications from the handler
        _handler.NotificationRequested += notification => BroadcastAsync(notification);
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _acceptTask = AcceptClientsAsync(_cts.Token);
        await Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _cts?.Cancel();

        // Close all client connections
        lock (_clientsLock)
        {
            foreach (var client in _clients)
            {
                client.Dispose();
            }
            _clients.Clear();
        }

        if (_acceptTask != null)
        {
            try
            {
                await _acceptTask.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken);
            }
            catch (TimeoutException)
            {
                _logger.LogWarning("Timeout waiting for accept task to complete");
            }
            catch (OperationCanceledException)
            {
                // Expected
            }
        }
    }

    private async Task AcceptClientsAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                // Create pipe with security that allows non-admin users to connect
                var pipeSecurity = CreatePipeSecurity();
                var pipeServer = NamedPipeServerStreamAcl.Create(
                    _config.PipeName,
                    PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous,
                    inBufferSize: 4096,
                    outBufferSize: 4096,
                    pipeSecurity);

                _logger.LogDebug("Waiting for client connection on pipe {PipeName}", _config.PipeName);
                await pipeServer.WaitForConnectionAsync(cancellationToken);

                var client = new ClientConnection(pipeServer, _logger, _handler, OnClientDisconnected);
                lock (_clientsLock)
                {
                    _clients.Add(client);
                }

                _logger.LogInformation("Client connected. Total clients: {Count}", _clients.Count);
                _ = client.StartAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error accepting client connection");
                await Task.Delay(1000, cancellationToken);
            }
        }
    }

    private void OnClientDisconnected(ClientConnection client)
    {
        lock (_clientsLock)
        {
            _clients.Remove(client);
        }
        _logger.LogInformation("Client disconnected. Total clients: {Count}", _clients.Count);
    }

    /// <summary>
    /// Broadcast notification to all connected clients
    /// </summary>
    public async Task BroadcastAsync(JsonRpcNotification notification, CancellationToken cancellationToken = default)
    {
        List<ClientConnection> clients;
        lock (_clientsLock)
        {
            clients = _clients.ToList();
        }

        foreach (var client in clients)
        {
            try
            {
                await client.SendNotificationAsync(notification, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to send notification to client");
            }
        }
    }

    private static PipeSecurity CreatePipeSecurity()
    {
        var security = new PipeSecurity();

        // Allow SYSTEM full control
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        // Allow Administrators full control
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        // Allow all authenticated users to read/write (for non-admin GUI)
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
            PipeAccessRights.ReadWrite,
            AccessControlType.Allow));

        return security;
    }
}

/// <summary>
/// Represents a connected client
/// </summary>
internal class ClientConnection : IDisposable
{
    private readonly NamedPipeServerStream _pipe;
    private readonly ILogger _logger;
    private readonly JsonRpcHandler _handler;
    private readonly Action<ClientConnection> _onDisconnected;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private bool _disposed;

    public ClientConnection(
        NamedPipeServerStream pipe,
        ILogger logger,
        JsonRpcHandler handler,
        Action<ClientConnection> onDisconnected)
    {
        _pipe = pipe;
        _logger = logger;
        _handler = handler;
        _onDisconnected = onDisconnected;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var reader = new StreamReader(_pipe, Encoding.UTF8, leaveOpen: true);

            while (!cancellationToken.IsCancellationRequested && _pipe.IsConnected)
            {
                var line = await reader.ReadLineAsync(cancellationToken);
                if (line == null) break;

                var response = await _handler.HandleAsync(line, cancellationToken);
                if (response != null)
                {
                    await SendAsync(response, cancellationToken);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown
        }
        catch (IOException)
        {
            // Client disconnected
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error handling client");
        }
        finally
        {
            _onDisconnected(this);
            Dispose();
        }
    }

    public async Task SendNotificationAsync(JsonRpcNotification notification, CancellationToken cancellationToken)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(notification);
        await SendAsync(json, cancellationToken);
    }

    private async Task SendAsync(string message, CancellationToken cancellationToken)
    {
        if (_disposed || !_pipe.IsConnected) return;

        await _writeLock.WaitAsync(cancellationToken);
        try
        {
            var bytes = Encoding.UTF8.GetBytes(message + "\n");
            await _pipe.WriteAsync(bytes, cancellationToken);
            await _pipe.FlushAsync(cancellationToken);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _pipe.Dispose();
        _writeLock.Dispose();
    }
}
