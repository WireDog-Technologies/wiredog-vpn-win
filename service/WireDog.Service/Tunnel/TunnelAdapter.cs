using System.IO.Pipes;
using System.Text;

namespace WireDog.Service.Tunnel;

/// <summary>
/// Reads tunnel stats via the AWG UAPI named pipe exposed by tunnel.dll.
/// Pipe path: \\.\pipe\ProtectedPrefix\Administrators\AmneziaWG\{name}
/// Protocol: send "get=1\n\n", parse key=value response lines.
/// </summary>
public class TunnelAdapter : IDisposable
{
    private readonly ILogger<TunnelAdapter>? _logger;
    private readonly string _tunnelName;
    private bool _disposed;

    public ulong TxBytes { get; private set; }
    public ulong RxBytes { get; private set; }
    public DateTime? LastHandshake { get; private set; }

    public TunnelAdapter(string tunnelName, ILogger<TunnelAdapter>? logger = null)
    {
        _tunnelName = tunnelName;
        _logger = logger;
    }

    public bool Open() => true;

    public void Close() { }

    /// <summary>
    /// Query the AWG UAPI pipe for peer stats (handshake time, bytes).
    /// Returns false if the pipe is not yet available.
    /// </summary>
    public bool ReadStats()
    {
        var pipeName = $@"ProtectedPrefix\Administrators\AmneziaWG\{_tunnelName}";
        try
        {
            using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None);
            pipe.Connect(500);

            var request = Encoding.UTF8.GetBytes("get=1\n\n");
            pipe.Write(request, 0, request.Length);
            pipe.Flush();

            using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
            ulong txBytes = 0, rxBytes = 0;
            ulong lastHandshakeSec = 0;

            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Length == 0) break;
                var eq = line.IndexOf('=');
                if (eq < 0) continue;
                var key = line[..eq];
                var val = line[(eq + 1)..];

                switch (key)
                {
                    case "tx_bytes" when ulong.TryParse(val, out var v): txBytes += v; break;
                    case "rx_bytes" when ulong.TryParse(val, out var v): rxBytes += v; break;
                    case "last_handshake_time_sec" when ulong.TryParse(val, out var v): lastHandshakeSec = v; break;
                }
            }

            TxBytes = txBytes;
            RxBytes = rxBytes;
            LastHandshake = lastHandshakeSec > 0
                ? DateTimeOffset.FromUnixTimeSeconds((long)lastHandshakeSec).UtcDateTime
                : null;

            return true;
        }
        catch (TimeoutException)
        {
            return false;
        }
        catch (Exception ex)
        {
            _logger?.LogDebug(ex, "UAPI stats read failed");
            return false;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
    }
}
