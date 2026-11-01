namespace NugetPackageManager.Common;

/// <summary>Where the framework list came from.</summary>
public enum TargetFrameworkSource
{
    /// <summary>Evaluated by <c>dotnet msbuild -getProperty</c>.</summary>
    MsBuild,

    /// <summary>A literal <c>TargetFramework(s)</c> declaration.</summary>
    Xml,

    /// <summary>The restore record in <c>project.assets.json</c>.</summary>
    Assets,

    /// <summary>Supplied by the caller.</summary>
    Override,
}
