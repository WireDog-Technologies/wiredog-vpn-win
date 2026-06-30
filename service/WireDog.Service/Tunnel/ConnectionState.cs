namespace WireDog.Service.Tunnel;

/// <summary>
/// Connection status enum
/// </summary>
public enum ConnectionStatus
{
    Disconnected,
    Connecting,
    Connected,
    Disconnecting,
    Error
}

/// <summary>
/// Connection state data
/// </summary>
public class ConnectionState
{
    public ConnectionStatus Status { get; set; } = ConnectionStatus.Disconnected;
    public string? ServerId { get; set; }
    public string? AssignedIp { get; set; }
    public DateTime? ConnectedAt { get; set; }
    public string? Error { get; set; }
}

/// <summary>
/// Manages connection state and notifies subscribers of changes
/// </summary>
public class ConnectionStateManager
{
    private readonly ILogger<ConnectionStateManager> _logger;
    private readonly object _lock = new();
    private ConnectionState _current = new();

    public event EventHandler<ConnectionState>? StateChanged;

    public ConnectionState Current
    {
        get
        {
            lock (_lock)
            {
                return new ConnectionState
                {
                    Status = _current.Status,
                    ServerId = _current.ServerId,
                    AssignedIp = _current.AssignedIp,
                    ConnectedAt = _current.ConnectedAt,
                    Error = _current.Error
                };
            }
        }
    }

    public ConnectionStateManager(ILogger<ConnectionStateManager> logger)
    {
        _logger = logger;
    }

    public void SetConnecting(string serverId)
    {
        UpdateState(s =>
        {
            s.Status = ConnectionStatus.Connecting;
            s.ServerId = serverId;
            s.AssignedIp = null;
            s.ConnectedAt = null;
            s.Error = null;
        });
    }

    public void SetConnected(string assignedIp, string serverId)
    {
        UpdateState(s =>
        {
            s.Status = ConnectionStatus.Connected;
            s.ServerId = serverId;
            s.AssignedIp = assignedIp;
            s.ConnectedAt = DateTime.UtcNow;
            s.Error = null;
        });
    }

    public void SetDisconnecting()
    {
        UpdateState(s =>
        {
            s.Status = ConnectionStatus.Disconnecting;
        });
    }

    public void SetDisconnected()
    {
        UpdateState(s =>
        {
            s.Status = ConnectionStatus.Disconnected;
            s.ServerId = null;
            s.AssignedIp = null;
            s.ConnectedAt = null;
            s.Error = null;
        });
    }

    public void SetError(string error)
    {
        UpdateState(s =>
        {
            s.Status = ConnectionStatus.Error;
            s.Error = error;
        });
    }

    private void UpdateState(Action<ConnectionState> update)
    {
        ConnectionState snapshot;
        lock (_lock)
        {
            update(_current);
            snapshot = Current;
        }

        _logger.LogDebug("Connection state changed to {Status}", snapshot.Status);
        StateChanged?.Invoke(this, snapshot);
    }
}
