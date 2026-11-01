
namespace NugetPackageManager.Core.Workspace.Cpm;

public sealed record CallNode(string Property, string Method, string Value) : ConditionNode;
