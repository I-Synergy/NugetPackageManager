namespace NugetPackageManager.Common;

/// <summary>
/// Codes and names shared by the core projects.
///
/// Kept in one place because they cross the sidecar protocol and several handlers compare
/// against them; duplicated literals drift apart, and a typo in an error code reaches the host
/// as an unknown failure.
/// </summary>
public static class Constants
{
    /// <summary>Request parameters are missing or malformed.</summary>
    public const string InvalidParams = "invalidParams";

    /// <summary>An unexpected failure inside a handler.</summary>
    public const string InternalError = "internalError";

    /// <summary>Version source: the project file itself.</summary>
    public const string SourceProject = "project";

    /// <summary>Version source: <c>Directory.Packages.props</c>.</summary>
    public const string SourceCentral = "central";

    /// <summary>Version source: the caller's override.</summary>
    public const string SourceOverride = "override";

    /// <summary>The central package management file name.</summary>
    public const string PropsFileName = "Directory.Packages.props";

    /// <summary>MSBuild property naming a single target framework.</summary>
    public const string TargetFramework = "TargetFramework";

    /// <summary>MSBuild property naming several target frameworks.</summary>
    public const string TargetFrameworks = "TargetFrameworks";

    /// <summary>How many packages the requirement closure may inspect before it gives up.</summary>
    public const int DefaultMaxInspected = 250;
}
