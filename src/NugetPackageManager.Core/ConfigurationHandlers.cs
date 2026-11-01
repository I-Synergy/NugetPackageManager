using System.Text.Json;
using NugetPackageManager.Core.NuGet.Configuration;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core;

/// <summary>NuGet config resolution the sidecar exposes over NDJSON.</summary>
public static class ConfigurationHandlers
{
    public static Dictionary<string, RpcHandler> Create() =>
        new(StringComparer.Ordinal)
        {
            ["resolveNuGetConfig"] = HandleResolveNuGetConfigAsync,
        };

    private static Task<object?> HandleResolveNuGetConfigAsync(JsonElement parameters, CancellationToken cancellationToken)
    {
        _ = cancellationToken;

        var workspaceRoots = ReadStringArray(parameters, "workspaceRoots");
        var platform = ReadRequiredString(parameters, "platform");
        var homeDirectory = ReadRequiredString(parameters, "homeDirectory");

        // The sidecar inherits the host's environment, so variable reads happen here rather than
        // crossing the wire. Only discovery paths and `%VAR%` expansion in user-level configs use it.
        var environment = new NuGetConfigEnvironment(platform, homeDirectory, Environment.GetEnvironmentVariable);

        var resolution = NuGetConfigResolver.Resolve(environment, workspaceRoots, File.ReadAllText);

        return Task.FromResult<object?>(new
        {
            sources = resolution.Sources.Select(source => new
            {
                name = source.Name,
                url = source.Url,
                username = source.Username,
                password = source.Password,
                patterns = source.Patterns,
            }),
            clearFound = resolution.ClearFound,
            failures = resolution.Failures.Select(failure => new
            {
                path = failure.Path,
                message = failure.Message,
            }),
        });
    }

    private static string ReadRequiredString(JsonElement parameters, string property)
    {
        var value = ReadOptionalString(parameters, property);
        return string.IsNullOrWhiteSpace(value)
            ? throw new RpcException(Constants.InvalidParams, $"'{property}' is required.")
            : value;
    }

    private static string? ReadOptionalString(JsonElement parameters, string property) =>
        parameters.ValueKind == JsonValueKind.Object
        && parameters.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string[] ReadStringArray(JsonElement parameters, string property)
    {
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return [.. value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString())
            .Where(item => !string.IsNullOrEmpty(item))
            .OfType<string>()];
    }
}
