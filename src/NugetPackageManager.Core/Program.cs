using NugetPackageManager.Core;
using NugetPackageManager.Core.NuGet.Sources;
using NugetPackageManager.Core.NuGet.Vulnerabilities;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Workspace;

using var sources = new NuGetSourceProvider();

var handlers = new Dictionary<string, RpcHandler>(StringComparer.Ordinal);
foreach (var (name, handler) in new NuGetCoreHandlers(new NuGetVulnerabilityReader(), sources).Create())
{
    handlers[name] = handler;
}

// One handler instance (and one workspace model) for the whole sidecar, so the per-project
// caches are shared by the plain and the progress-reporting entry points.
var workspaceHandlers = new WorkspaceHandlers(new WorkspaceModelService());
foreach (var (name, handler) in workspaceHandlers.Create())
{
    handlers[name] = handler;
}

var contextHandlers = new Dictionary<string, ContextRpcHandler>(StringComparer.Ordinal);
foreach (var (name, handler) in workspaceHandlers.CreateContextHandlers())
{
    contextHandlers[name] = handler;
}

foreach (var (name, handler) in new DependencyHandlers(sources).Create())
{
    handlers[name] = handler;
}

foreach (var (name, handler) in DiagnosticHandlers.Create())
{
    handlers[name] = handler;
}

foreach (var (name, handler) in ToolchainHandlers.Create())
{
    handlers[name] = handler;
}

foreach (var (name, handler) in ConfigurationHandlers.Create())
{
    handlers[name] = handler;
}

using var server = new NdjsonServer(Console.In, Console.Out, Console.Error, handlers, contextHandlers);
return await server.RunAsync(CancellationToken.None).ConfigureAwait(false);
