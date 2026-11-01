using System.Text.Json;
using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Protocol;

/// <summary>One request line: <c>{"id":1,"method":"ping","params":{...}}</c>.</summary>
public sealed record RpcRequest(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("method")] string Method,
    [property: JsonPropertyName("params")] JsonElement Params);

/// <summary>One response line: <c>{"id":1,"ok":true,"value":...}</c> or <c>{"id":1,"ok":false,"error":{...}}</c>.</summary>
public sealed record RpcResponse
{
    [JsonPropertyName("id")]
    public required long Id { get; init; }

    [JsonPropertyName("ok")]
    public required bool Ok { get; init; }

    [JsonPropertyName("value")]
    public object? Value { get; init; }

    [JsonPropertyName("error")]
    public RpcError? Error { get; init; }
}

/// <summary>Structured failure. The TypeScript adapter maps <see cref="Code"/> onto user-facing text.</summary>
public sealed record RpcError(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message);

/// <summary>A failure a handler can report without throwing an arbitrary exception.</summary>
public sealed class RpcException : Exception
{
    public RpcException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    public RpcException(string code, string message, Exception innerException)
        : base(message, innerException)
    {
        Code = code;
    }

    public RpcException()
        : base("The request failed.")
    {
        Code = "internalError";
    }

    public string Code { get; }
}

/// <summary>Serialization settings shared by every line on the wire.</summary>
public static class ProtocolJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
