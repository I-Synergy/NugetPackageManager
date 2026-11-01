
namespace NugetPackageManager.Core.Workspace.Cpm;

public sealed record AndNode(ConditionNode Left, ConditionNode Right) : ConditionNode;
