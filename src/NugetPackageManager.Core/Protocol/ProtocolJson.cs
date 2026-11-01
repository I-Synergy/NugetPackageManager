using System.Text.Json;
using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Protocol;

/// <summary>Serialization settings shared by every line on the wire.</summary>
public static class ProtocolJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
