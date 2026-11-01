
namespace NugetPackageManager.Core.Workspace.Cpm;

public sealed record CompareNode(string Property, string Operator, string Value) : ConditionNode;
