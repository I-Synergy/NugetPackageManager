using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;

namespace NugetPackageManager.Core.Protocol;

/// <summary>Handles one request. Throwing <see cref="RpcException"/> yields a structured error.</summary>
public delegate Task<object?> RpcHandler(JsonElement parameters, CancellationToken cancellationToken);

/// <summary>
/// Newline-delimited JSON server over a reader/writer pair.
///
/// One request or response per line: JSON escapes newlines inside strings, so the
/// framing is unambiguous without a length prefix. Requests run concurrently and
/// are matched by id; <c>cancel</c> aborts an in-flight id.
/// </summary>
public sealed class NdjsonServer : IDisposable
{
    private const int ProtocolVersion = 1;

    private readonly TextReader input;
    private readonly TextWriter output;
    private readonly TextWriter error;
    private readonly Dictionary<string, RpcHandler> handlers;
    private readonly Dictionary<string, ContextRpcHandler> contextHandlers;
    private readonly ConcurrentDictionary<long, CancellationTokenSource> inFlight = new();
    private readonly SemaphoreSlim writeLock = new(1, 1);
    private bool disposed;

    public NdjsonServer(TextReader input, TextWriter output, TextWriter error)
        : this(input, output, error, handlers: null)
    {
    }

    /// <summary>Creates a server over the given streams.</summary>
    /// <param name="input">Request lines, one JSON object per line.</param>
    /// <param name="output">Handshake, progress and response lines.</param>
    /// <param name="error">Out-of-band diagnostics for the host's log.</param>
    /// <param name="handlers">The plain request handlers.</param>
    /// <param name="contextHandlers">
    /// Handlers that may stream progress. One of these wins over a plain handler of the same name.
    /// </param>
    public NdjsonServer(
        TextReader input,
        TextWriter output,
        TextWriter error,
        IReadOnlyDictionary<string, RpcHandler>? handlers,
        IReadOnlyDictionary<string, ContextRpcHandler>? contextHandlers = null)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(error);

        this.input = input;
        this.output = output;
        this.error = error;
        this.handlers = BuildHandlers(handlers);
        this.contextHandlers = BuildContextHandlers(contextHandlers);
    }

    /// <summary>Reads until the input closes, then waits for outstanding requests.</summary>
    public async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        await WriteHandshakeAsync(cancellationToken).ConfigureAwait(false);

        var running = new List<Task>();
        while (true)
        {
            string? line;
            try
            {
                line = await input.ReadLineAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            if (line is null)
            {
                break;
            }

            if (line.Length == 0)
            {
                continue;
            }

            running.Add(ProcessLineAsync(line, cancellationToken));
        }

        await Task.WhenAll(running).ConfigureAwait(false);
        return 0;
    }

    private static Dictionary<string, RpcHandler> DefaultHandlers() =>
        new(StringComparer.Ordinal)
        {
            ["ping"] = HandlePingAsync,
        };

    /// <summary>Built-in handlers first, then the ones the host supplies.</summary>
    private static Dictionary<string, RpcHandler> BuildHandlers(IReadOnlyDictionary<string, RpcHandler>? extra)
    {
        var merged = new Dictionary<string, RpcHandler>(StringComparer.Ordinal);
        foreach (var (name, handler) in DefaultHandlers())
        {
            merged[name] = handler;
        }

        if (extra is not null)
        {
            foreach (var (name, handler) in extra)
            {
                merged[name] = handler;
            }
        }

        return merged;
    }

    private static Dictionary<string, ContextRpcHandler> BuildContextHandlers(
        IReadOnlyDictionary<string, ContextRpcHandler>? extra)
    {
        var merged = new Dictionary<string, ContextRpcHandler>(StringComparer.Ordinal);
        if (extra is not null)
        {
            foreach (var (name, handler) in extra)
            {
                merged[name] = handler;
            }
        }

        return merged;
    }

    private static Task<object?> HandlePingAsync(JsonElement parameters, CancellationToken cancellationToken)
    {
        _ = parameters;
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult<object?>(new { pong = true, protocol = ProtocolVersion });
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Design",
        "CA1031:Do not catch general exception types",
        Justification = "A protocol boundary must answer every request instead of dropping it.")]
    private async Task ProcessLineAsync(string line, CancellationToken cancellationToken)
    {
        RpcRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<RpcRequest>(line, ProtocolJson.Options);
        }
        catch (JsonException ex)
        {
            await WriteErrorAsync(0, "invalidRequest", ex.Message, cancellationToken).ConfigureAwait(false);
            return;
        }

        if (request is null || string.IsNullOrEmpty(request.Method))
        {
            await WriteErrorAsync(request?.Id ?? 0, "invalidRequest", "A request needs a method.", cancellationToken)
                .ConfigureAwait(false);
            return;
        }

        if (string.Equals(request.Method, "cancel", StringComparison.Ordinal))
        {
            await HandleCancelAsync(request, cancellationToken).ConfigureAwait(false);
            return;
        }

        Func<CancellationToken, Task<object?>> invoke;
        if (contextHandlers.TryGetValue(request.Method, out var contextHandler))
        {
            var context = new RpcContext(
                request.Id,
                (stage, percent, completed, total) =>
                    WriteProgressAsync(request.Id, stage, percent, completed, total));
            invoke = token => contextHandler(request.Params, context, token);
        }
        else if (handlers.TryGetValue(request.Method, out var handler))
        {
            invoke = token => handler(request.Params, token);
        }
        else
        {
            await WriteErrorAsync(
                request.Id,
                "unknownMethod",
                string.Create(CultureInfo.InvariantCulture, $"Unknown method '{request.Method}'."),
                cancellationToken).ConfigureAwait(false);
            return;
        }

        using var source = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        inFlight[request.Id] = source;
        try
        {
            var value = await invoke(source.Token).ConfigureAwait(false);
            await WriteAsync(new RpcResponse { Id = request.Id, Ok = true, Value = value }, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            await WriteErrorAsync(request.Id, "cancelled", "The request was cancelled.", cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RpcException ex)
        {
            await WriteErrorAsync(request.Id, ex.Code, ex.Message, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            await error.WriteLineAsync(string.Create(
                CultureInfo.InvariantCulture,
                $"request {request.Id} ({request.Method}) failed: {ex}")).ConfigureAwait(false);
            await WriteErrorAsync(request.Id, "internalError", ex.Message, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            inFlight.TryRemove(request.Id, out _);
        }
    }

    private async Task HandleCancelAsync(RpcRequest request, CancellationToken cancellationToken)
    {
        if (request.Params.ValueKind != JsonValueKind.Object
            || !request.Params.TryGetProperty("target", out var target)
            || !target.TryGetInt64(out var targetId))
        {
            await WriteErrorAsync(request.Id, "invalidParams", "cancel requires a numeric 'target'.", cancellationToken)
                .ConfigureAwait(false);
            return;
        }

        if (inFlight.TryGetValue(targetId, out var source))
        {
            try
            {
                await source.CancelAsync().ConfigureAwait(false);
            }
            catch (ObjectDisposedException)
            {
                // The request finished between the lookup and the cancel.
            }
        }

        await WriteAsync(
            new RpcResponse { Id = request.Id, Ok = true, Value = new { cancelled = targetId } },
            cancellationToken).ConfigureAwait(false);
    }

    private Task WriteHandshakeAsync(CancellationToken cancellationToken) =>
        WriteAsync(
            new
            {
                ready = true,
                protocol = ProtocolVersion,
                version = typeof(NdjsonServer).Assembly.GetName().Version?.ToString() ?? "0.0.0",
            },
            cancellationToken);

    /// <summary>
    /// Writes one progress line. Failures are swallowed on purpose: a long read must keep going
    /// when a progress write cannot land, and the host decides on a stall from silence alone.
    /// </summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Design",
        "CA1031:Do not catch general exception types",
        Justification = "Progress is advisory; losing a line must never fail the request it describes.")]
    private async Task WriteProgressAsync(long id, string stage, int percent, int completed, int total)
    {
        try
        {
            // No cancellation token: a half-written line would break the framing for every
            // request that shares the stream.
            await WriteAsync(
                new
                {
                    type = "progress",
                    id,
                    stage,
                    percent,
                    completed,
                    total,
                },
                CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Advisory only — the host's stall guard is the backstop.
        }
    }

    private Task WriteErrorAsync(long id, string code, string message, CancellationToken cancellationToken) =>
        WriteAsync(
            new RpcResponse { Id = id, Ok = false, Error = new RpcError(code, message) },
            cancellationToken);

    private async Task WriteAsync(object message, CancellationToken cancellationToken)
    {
        var line = JsonSerializer.Serialize(message, ProtocolJson.Options);

        await writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await output.WriteLineAsync(line.AsMemory(), cancellationToken).ConfigureAwait(false);
            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            writeLock.Release();
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        foreach (var source in inFlight.Values)
        {
            source.Dispose();
        }

        inFlight.Clear();
        writeLock.Dispose();
    }
}
