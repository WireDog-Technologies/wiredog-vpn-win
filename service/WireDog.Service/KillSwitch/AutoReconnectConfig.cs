using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using WireDog.Service.Ipc;

namespace WireDog.Service.KillSwitch;

/// <summary>
/// Persists VPN connection parameters across service restarts and reboots.
/// Used by auto-reconnect on boot when Always-On Kill Switch is active.
/// Encrypted with DPAPI (current user scope) since config contains WireGuard private key.
/// Stored at %ProgramData%/WireDog/auto-reconnect.dat
/// </summary>
public class AutoReconnectConfig
{
    private static readonly string ConfigPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "WireDog", "auto-reconnect.dat");

    [JsonPropertyName("serverId")]
    public string ServerId { get; set; } = "";

    [JsonPropertyName("config")]
    public WireGuardConfigParams? Config { get; set; }

    [JsonPropertyName("killSwitch")]
    public bool KillSwitch { get; set; }

    [JsonPropertyName("splitTunneling")]
    public SplitTunnelingParams? SplitTunneling { get; set; }

    [JsonPropertyName("savedAt")]
    public DateTime SavedAt { get; set; }

    /// <summary>
    /// Create from ConnectParams (the same object used by HandleConnectAsync)
    /// </summary>
    public static AutoReconnectConfig FromConnectParams(ConnectParams connectParams)
    {
        return new AutoReconnectConfig
        {
            ServerId = connectParams.ServerId,
            Config = connectParams.Config,
            KillSwitch = connectParams.KillSwitch,
            SplitTunneling = connectParams.SplitTunneling,
            SavedAt = DateTime.UtcNow
        };
    }

    /// <summary>
    /// Convert back to ConnectParams for use with HandleConnectAsync
    /// </summary>
    public ConnectParams ToConnectParams()
    {
        return new ConnectParams
        {
            ServerId = ServerId,
            Config = Config,
            KillSwitch = KillSwitch,
            SplitTunneling = SplitTunneling
        };
    }

    /// <summary>
    /// Load and decrypt config from disk. Returns null if not found or corrupt.
    /// </summary>
    public static AutoReconnectConfig? Load()
    {
        try
        {
            if (!File.Exists(ConfigPath))
                return null;

            var encryptedBytes = File.ReadAllBytes(ConfigPath);
            var jsonBytes = ProtectedData.Unprotect(encryptedBytes, null, DataProtectionScope.CurrentUser);
            var json = Encoding.UTF8.GetString(jsonBytes);
            return JsonSerializer.Deserialize<AutoReconnectConfig>(json);
        }
        catch
        {
            // Corrupt, missing, or tampered — treat as absent
            return null;
        }
    }

    /// <summary>
    /// Encrypt and save config to disk.
    /// </summary>
    public void Save()
    {
        try
        {
            var dir = Path.GetDirectoryName(ConfigPath)!;
            Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = false });
            var jsonBytes = Encoding.UTF8.GetBytes(json);
            var encryptedBytes = ProtectedData.Protect(jsonBytes, null, DataProtectionScope.CurrentUser);
            File.WriteAllBytes(ConfigPath, encryptedBytes);
        }
        catch
        {
            // Best effort — if save fails, boot reconnect won't work but that's acceptable
        }
    }

    /// <summary>
    /// Delete config from disk.
    /// </summary>
    public static void Delete()
    {
        try
        {
            if (File.Exists(ConfigPath))
                File.Delete(ConfigPath);
        }
        catch { }
    }

    /// <summary>
    /// Check if a config file exists on disk.
    /// </summary>
    public static bool Exists()
    {
        return File.Exists(ConfigPath);
    }
}
