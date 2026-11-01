
namespace NugetPackageManager.Core.Workspace.Cpm;

public sealed record AndNode(IConditionNode Left, IConditionNode Right) : IConditionNode;
