
namespace NugetPackageManager.Core.Workspace.Cpm;

public sealed record OrNode(ConditionNode Left, ConditionNode Right) : ConditionNode;
