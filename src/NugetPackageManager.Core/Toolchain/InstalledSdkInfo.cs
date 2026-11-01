using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Toolchain;

/// <summary>One installed SDK (<c>InstalledSdkInfo</c>).</summary>
public sealed record InstalledSdkInfo
{
    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    [JsonPropertyName("Path")]
    public required string Path { get; init; }

    /// <summary><c>system</c> = on PATH, <c>private</c> = installed by the extension.</summary>
    [JsonPropertyName("Source")]
    public required string Source { get; init; }
}
