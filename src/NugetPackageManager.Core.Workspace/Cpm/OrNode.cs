
namespace NugetPackageManager.Core.Workspace.Cpm;

public sealed record OrNode(IConditionNode Left, IConditionNode Right) : IConditionNode;
