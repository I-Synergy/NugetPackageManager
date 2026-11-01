namespace NugetPackageManager.Core.Workspace;

/// <summary>
/// A workspace failure with a stable code the host maps onto a user-facing message.
/// Kept separate from <c>Core.NuGet.NuGetSourceException</c> so the two projects stay independent.
/// </summary>
public sealed class WorkspaceException : Exception
{
    public WorkspaceException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    public WorkspaceException(string code, string message, Exception innerException)
        : base(message, innerException)
    {
        Code = code;
    }

    public WorkspaceException()
        : base("The workspace operation failed.")
    {
        Code = "workspaceError";
    }

    public string Code { get; }
}
