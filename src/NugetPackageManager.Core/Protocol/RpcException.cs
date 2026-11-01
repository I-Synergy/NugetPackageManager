
namespace NugetPackageManager.Core.Protocol;

/// <summary>A failure a handler can report without throwing an arbitrary exception.</summary>
public sealed class RpcException : Exception
{
    /// <summary>Code for a request whose parameters are missing or malformed.</summary>
    public const string InvalidParams = "invalidParams";

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
