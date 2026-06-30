using System.Text.Json;
using System.Text.Json.Serialization;

namespace WireDog.Service.KillSwitch;

/// <summary>
/// Persists advanced kill switch state across service restarts and reboots.
/// Stored at %ProgramData%/WireDog/advanced-killswitch.json
/// </summary>
public class AdvancedKillSwitchConfig
{
    private static readonly string ConfigPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "WireDog", "advanced-killswitch.json");

    [JsonPropertyName("advancedModeEnabled")]
    public bool AdvancedModeEnabled { get; set; }

    [JsonPropertyName("advancedModeActive")]
    public bool AdvancedModeActive { get; set; }

    [JsonPropertyName("lastServerEndpoint")]
    public string? LastServerEndpoint { get; set; }

    public static AdvancedKillSwitchConfig Load()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath);
                var config = JsonSerializer.Deserialize<AdvancedKillSwitchConfig>(json);
                if (config != null) return config;
            }
        }
        catch
        {
            // Corrupt or missing config — fall through to return defaults
        }

        return new AdvancedKillSwitchConfig();
    }

    public void Save()
    {
        try
        {
            var dir = Path.GetDirectoryName(ConfigPath)!;
            Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(ConfigPath, json);
        }
        catch
        {
            // Best effort
        }
    }

    public static void Delete()
    {
        try
        {
            if (File.Exists(ConfigPath))
                File.Delete(ConfigPath);
        }
        catch { }
    }
}
