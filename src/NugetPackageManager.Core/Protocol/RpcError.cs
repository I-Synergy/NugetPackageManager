using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Protocol;

/// <summary>Structured failure. The TypeScript adapter maps <see cref="Code"/> onto user-facing text.</summary>
public sealed record RpcError(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message);
