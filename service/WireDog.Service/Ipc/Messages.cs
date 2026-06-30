using System.Text.Json.Serialization;

namespace WireDog.Service.Ipc;

/// <summary>
/// JSON-RPC 2.0 Request
/// </summary>
public class JsonRpcRequest
{
    [JsonPropertyName("jsonrpc")]
    public string JsonRpc { get; set; } = "2.0";

    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("method")]
    public string Method { get; set; } = "";

    [JsonPropertyName("params")]
    public object? Params { get; set; }
}

/// <summary>
/// JSON-RPC 2.0 Response
/// </summary>
public class JsonRpcResponse
{
    [JsonPropertyName("jsonrpc")]
    public string JsonRpc { get; set; } = "2.0";

    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("result")]
    public object? Result { get; set; }

    [JsonPropertyName("error")]
    public JsonRpcError? Error { get; set; }

    public static JsonRpcResponse Success(string? id, object? result) => new()
    {
        Id = id,
        Result = result
    };

    public static JsonRpcResponse Failure(string? id, int code, string message, object? data = null) => new()
    {
        Id = id,
        Error = new JsonRpcError { Code = code, Message = message, Data = data }
    };
}

/// <summary>
/// JSON-RPC 2.0 Error
/// </summary>
public class JsonRpcError
{
    [JsonPropertyName("code")]
    public int Code { get; set; }

    [JsonPropertyName("message")]
    public string Message { get; set; } = "";

    [JsonPropertyName("data")]
    public object? Data { get; set; }
}

/// <summary>
/// JSON-RPC 2.0 Notification (no id, no response expected)
/// </summary>
public class JsonRpcNotification
{
    [JsonPropertyName("jsonrpc")]
    public string JsonRpc { get; set; } = "2.0";

    [JsonPropertyName("method")]
    public string Method { get; set; } = "";

    [JsonPropertyName("params")]
    public object? Params { get; set; }
}

// ============ Method Parameters ============

public class ConnectParams
{
    [JsonPropertyName("serverId")]
    public string ServerId { get; set; } = "";

    [JsonPropertyName("config")]
    public WireGuardConfigParams? Config { get; set; }

    [JsonPropertyName("killSwitch")]
    public bool KillSwitch { get; set; }

    [JsonPropertyName("localMode")]
    public bool LocalMode { get; set; }

    [JsonPropertyName("splitTunneling")]
    public SplitTunnelingParams? SplitTunneling { get; set; }
}

public class SplitTunnelingParams
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; }

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = "exclude";

    [JsonPropertyName("apps")]
    public List<SplitTunnelAppParam> Apps { get; set; } = new();

    [JsonPropertyName("ips")]
    public List<string> Ips { get; set; } = new();
}

public class SplitTunnelAppParam
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("exePath")]
    public string ExePath { get; set; } = "";
}

public class WireGuardConfigParams
{
    [JsonPropertyName("privateKey")]
    public string PrivateKey { get; set; } = "";

    [JsonPropertyName("address")]
    public string Address { get; set; } = "";

    [JsonPropertyName("dns")]
    public string Dns { get; set; } = "";

    [JsonPropertyName("serverPublicKey")]
    public string ServerPublicKey { get; set; } = "";

    [JsonPropertyName("endpoint")]
    public string Endpoint { get; set; } = "";

    [JsonPropertyName("allowedIPs")]
    public string AllowedIPs { get; set; } = "";

    [JsonPropertyName("persistentKeepalive")]
    public int PersistentKeepalive { get; set; } = 25;

    [JsonPropertyName("awg")]
    public AwgParams? Awg { get; set; }
}

public class AwgParams
{
    [JsonPropertyName("Jc")]
    public int Jc { get; set; }

    [JsonPropertyName("Jmin")]
    public int Jmin { get; set; }

    [JsonPropertyName("Jmax")]
    public int Jmax { get; set; }

    [JsonPropertyName("S1")]
    public int S1 { get; set; }

    [JsonPropertyName("S2")]
    public int S2 { get; set; }

    [JsonPropertyName("H1")]
    public uint H1 { get; set; }

    [JsonPropertyName("H2")]
    public uint H2 { get; set; }

    [JsonPropertyName("H3")]
    public uint H3 { get; set; }

    [JsonPropertyName("H4")]
    public uint H4 { get; set; }
}

// ============ Method Results ============

public class ConnectResult
{
    [JsonPropertyName("sessionId")]
    public string SessionId { get; set; } = "";

    [JsonPropertyName("assignedIp")]
    public string AssignedIp { get; set; } = "";

    [JsonPropertyName("serverIp")]
    public string ServerIp { get; set; } = "";
}

public class StatusResult
{
    [JsonPropertyName("state")]
    public string State { get; set; } = "disconnected";

    [JsonPropertyName("server")]
    public ServerInfo? Server { get; set; }

    [JsonPropertyName("connectedSince")]
    public string? ConnectedSince { get; set; }

    [JsonPropertyName("killSwitchActive")]
    public bool KillSwitchActive { get; set; }

    [JsonPropertyName("killSwitchState")]
    public string KillSwitchState { get; set; } = "disabled";

    [JsonPropertyName("assignedIp")]
    public string? AssignedIp { get; set; }

    [JsonPropertyName("advancedKillSwitchEnabled")]
    public bool AdvancedKillSwitchEnabled { get; set; }

    [JsonPropertyName("advancedKillSwitchActive")]
    public bool AdvancedKillSwitchActive { get; set; }
}

public class ServerInfo
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("endpoint")]
    public string Endpoint { get; set; } = "";
}

public class StatsResult
{
    [JsonPropertyName("bytesIn")]
    public long BytesIn { get; set; }

    [JsonPropertyName("bytesOut")]
    public long BytesOut { get; set; }
}

public class PingResult
{
    [JsonPropertyName("version")]
    public string Version { get; set; } = "1.0.0";

    [JsonPropertyName("uptime")]
    public long Uptime { get; set; }
}

public class ConfigResult
{
    [JsonPropertyName("localMode")]
    public bool LocalMode { get; set; }

    [JsonPropertyName("devMode")]
    public bool DevMode { get; set; }

    [JsonPropertyName("pipeName")]
    public string PipeName { get; set; } = "WireDog";
}

// ============ Notifications ============

public class StatusChangedParams
{
    [JsonPropertyName("state")]
    public string State { get; set; } = "";

    [JsonPropertyName("killSwitchActive")]
    public bool KillSwitchActive { get; set; }

    [JsonPropertyName("killSwitchState")]
    public string KillSwitchState { get; set; } = "disabled";

    [JsonPropertyName("assignedIp")]
    public string? AssignedIp { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("advancedKillSwitchEnabled")]
    public bool AdvancedKillSwitchEnabled { get; set; }

    [JsonPropertyName("advancedKillSwitchActive")]
    public bool AdvancedKillSwitchActive { get; set; }
}

// ============ Advanced Kill Switch Params ============

public class DisconnectParams
{
    [JsonPropertyName("disableProtection")]
    public bool DisableProtection { get; set; }
}

// ============ Error Codes ============

public static class JsonRpcErrorCodes
{
    public const int ParseError = -32700;
    public const int InvalidRequest = -32600;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32603;

    // Custom error codes
    public const int AlreadyConnected = -1001;
    public const int NotConnected = -1002;
    public const int ConnectionFailed = -1003;
    public const int KillSwitchFailed = -1004;
    public const int WireGuardNotFound = -1005;
}
