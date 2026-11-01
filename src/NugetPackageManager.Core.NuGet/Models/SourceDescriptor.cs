using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>
/// One package source, already resolved to credentials by the TypeScript side.
/// Script execution and <c>%VAR%</c> expansion stay in the host: the sidecar only
/// ever receives a URL and a user name/password pair.
/// </summary>
public sealed record SourceDescriptor
{
    [JsonPropertyName("url")]
    public required string Url { get; init; }

    [JsonPropertyName("username")]
    public string? Username { get; init; }

    [JsonPropertyName("password")]
    public string? Password { get; init; }

    /// <summary>
    /// Proxy URL from the host's <c>http.proxy</c> setting or environment. Read in VS Code,
    /// passed in here: the sidecar must not decide its own network path.
    /// </summary>
    [JsonPropertyName("proxy")]
    public string? Proxy { get; init; }
}
