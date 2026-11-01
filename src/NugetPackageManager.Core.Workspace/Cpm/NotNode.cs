
namespace NugetPackageManager.Core.Workspace.Cpm;

public sealed record NotNode(IConditionNode Operand) : IConditionNode;
