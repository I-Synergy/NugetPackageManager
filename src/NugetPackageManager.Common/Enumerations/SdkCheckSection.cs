namespace NugetPackageManager.Common;

/// <summary>The section a <c>dotnet --list-sdks</c> style report is currently in.</summary>
public enum SdkCheckSection
{
    /// <summary>No heading seen yet.</summary>
    None,

    /// <summary>The SDK list.</summary>
    Sdks,

    /// <summary>The runtime list.</summary>
    Runtimes,
}
