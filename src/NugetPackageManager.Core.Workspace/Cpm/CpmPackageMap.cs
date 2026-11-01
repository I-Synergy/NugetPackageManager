
namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// A parsed <c>Directory.Packages.props</c>: unconditional versions, the conditional groups in
/// document order, and whether any conditional group exists at all.
/// </summary>
public sealed record CpmPackageMap(
    Dictionary<string, string> Unconditional,
    List<CpmFrameworkEntry> Conditional,
    bool HasConditionalGroups);
