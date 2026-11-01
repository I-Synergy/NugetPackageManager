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

foreach (var (name, handler) in new WorkspaceHandlers(new WorkspaceModelService()).Create())
{
    handlers[name] = handler;
}

using var server = new NdjsonServer(Console.In, Console.Out, Console.Error, handlers);
return await server.RunAsync(CancellationToken.None).ConfigureAwait(false);
