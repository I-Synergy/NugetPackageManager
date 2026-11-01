
namespace NugetPackageManager.Core.Toolchain;

/// <summary>The <c>sdk</c> section of a <c>global.json</c>.</summary>
public sealed record GlobalJsonSettings(string? Version, string? RollForward, bool? AllowPrerelease);
