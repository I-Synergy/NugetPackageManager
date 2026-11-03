using System.Text.Json;

namespace NugetPackageManager.Core.Protocol;

/// <summary>
/// Handles one request that may stream progress lines before it answers.
/// Throwing <see cref="RpcException"/> yields a structured error.
/// </summary>
public delegate Task<object?> ContextRpcHandler(
    JsonElement parameters,
    RpcContext context,
    CancellationToken cancellationToken);

/// <summary>
/// The per-request handle a <see cref="ContextRpcHandler"/> uses to emit progress.
///
/// Progress is written as its own line on the same stream as the response, so a host that
/// knows the protocol can show "42 of 463" while a long read is still running. The response
/// line is still the only thing that settles the request.
/// </summary>
public sealed class RpcContext
{
    private readonly Func<string, int, int, int, Task> report;

    internal RpcContext(long requestId, Func<string, int, int, int, Task> report)
    {
        RequestId = requestId;
        this.report = report;
    }

    /// <summary>The id of the request this context belongs to; the host matches on it.</summary>
    public long RequestId { get; }

    /// <summary>
    /// Writes one <c>{"type":"progress","id":…,"stage":…,"percent":…,"completed":…,"total":…}</c>
    /// line. Reporting never fails the handler: a broken stream is swallowed here and left to the
    /// host's own stall handling.
    /// </summary>
    /// <param name="stage">Human-readable status, e.g. <c>Parsing projects (1/20)…</c>.</param>
    /// <param name="percent">Overall completion, 0-100.</param>
    /// <param name="completed">Units finished so far, or 0 when the caller only reports a stage.</param>
    /// <param name="total">Units expected in total, or 0 when unknown.</param>
    public Task ReportProgressAsync(string stage, int percent, int completed = 0, int total = 0) =>
        report(stage, percent, completed, total);
}
