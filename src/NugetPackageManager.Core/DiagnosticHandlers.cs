using System.Text.Json;
using NugetPackageManager.Core.Diagnostics;
using NugetPackageManager.Core.Protocol;

namespace NugetPackageManager.Core;

/// <summary>
/// Classifies raw <c>dotnet</c> output the host captured. The host still owns spawning,
/// progress streaming and cancellation; it only sends the text and the context.
/// </summary>
public sealed class DiagnosticHandlers
{
    public static Dictionary<string, RpcHandler> Create() =>
        new(StringComparer.Ordinal)
        {
            ["classifyDotnetFailure"] = HandleClassifyDotnetFailureAsync,
        };

    private static Task<object?> HandleClassifyDotnetFailureAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        _ = cancellationToken;

        var output = ReadOptionalString(parameters, "output");
        if (output is null)
        {
            throw new RpcException("invalidParams", "'output' is required.");
        }

        var context = new DotnetFailureContext(
            ProjectPath: ReadOptionalString(parameters, "projectPath"),
            PinnedSdkVersion: ReadOptionalString(parameters, "pinnedSdkVersion"),
            GlobalJsonPath: ReadOptionalString(parameters, "globalJsonPath"),
            SpawnFailed: ReadBoolean(parameters, "spawnFailed"));

        return Task.FromResult<object?>(DotnetFailureClassifier.Classify(output, context));
    }

    private static string? ReadOptionalString(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool ReadBoolean(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.True;
}
