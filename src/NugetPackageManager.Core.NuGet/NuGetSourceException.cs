namespace NugetPackageManager.Core.NuGet;

/// <summary>
/// A failure the TypeScript adapter maps onto a user-facing message. The code is the
/// stable part; the message is for logs.
/// </summary>
public sealed class NuGetSourceException : Exception
{
    public NuGetSourceException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    public NuGetSourceException(string code, string message, Exception innerException)
        : base(message, innerException)
    {
        Code = code;
    }

    public NuGetSourceException()
        : base("The package source request failed.")
    {
        Code = "sourceUnreachable";
    }

    public string Code { get; }
}
