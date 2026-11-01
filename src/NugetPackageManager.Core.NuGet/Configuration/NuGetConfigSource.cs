namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>One <c>&lt;packageSources&gt;/&lt;add&gt;</c> entry as the file declares it.</summary>
public sealed record NuGetConfigSource(string Name, string Url);
