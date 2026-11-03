// File: tests/NugetPackageManager.Core.Tests/Protocol/NdjsonServerTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.

using System.Text.Json;
using NugetPackageManager.Core.Protocol;

namespace NugetPackageManager.Core.Tests.Protocol;

[TestClass]
public class NdjsonServerTests
{
    [TestMethod]
    [TestCategory("Unit")]
    public async Task RunAsync_EmptyInput_WritesHandshake()
    {
        // Act
        var lines = await RunServerAsync(string.Empty);

        // Assert
        Assert.AreEqual(1, lines.Count);
        Assert.IsTrue(lines[0].GetProperty("ready").GetBoolean());
        Assert.AreEqual(1, lines[0].GetProperty("protocol").GetInt32());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RunAsync_PingRequest_AnswersWithPong()
    {
        // Arrange
        const string Input = "{\"id\":7,\"method\":\"ping\"}\n";

        // Act
        var lines = await RunServerAsync(Input);

        // Assert
        var response = FindById(lines, 7);
        Assert.IsTrue(response.GetProperty("ok").GetBoolean());
        Assert.IsTrue(response.GetProperty("value").GetProperty("pong").GetBoolean());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RunAsync_UnknownMethod_ReportsUnknownMethodCode()
    {
        // Arrange
        const string Input = "{\"id\":1,\"method\":\"nope\"}\n";

        // Act
        var lines = await RunServerAsync(Input);

        // Assert
        var response = FindById(lines, 1);
        Assert.IsFalse(response.GetProperty("ok").GetBoolean());
        Assert.AreEqual("unknownMethod", ErrorCodeOf(response));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RunAsync_MalformedLine_RejectsItAndKeepsReading()
    {
        // Arrange
        const string Input = "{not json}\n{\"id\":2,\"method\":\"ping\"}\n";

        // Act
        var lines = await RunServerAsync(Input);

        // Assert
        Assert.AreEqual("invalidRequest", ErrorCodeOf(FindById(lines, 0)));
        Assert.IsTrue(FindById(lines, 2).GetProperty("ok").GetBoolean());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RunAsync_CancelForRunningRequest_ReportsCancelled()
    {
        // Arrange
        var started = new TaskCompletionSource();
        var handlers = new Dictionary<string, RpcHandler>(StringComparer.Ordinal)
        {
            ["slow"] = async (_, cancellationToken) =>
            {
                started.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
                return null;
            },
        };
        const string Input =
            "{\"id\":10,\"method\":\"slow\"}\n{\"id\":11,\"method\":\"cancel\",\"params\":{\"target\":10}}\n";

        // Act
        var running = RunServerAsync(Input, handlers);
        await started.Task;
        var lines = await running;

        // Assert
        Assert.AreEqual("cancelled", ErrorCodeOf(FindById(lines, 10)));
        Assert.IsTrue(FindById(lines, 11).GetProperty("ok").GetBoolean());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RunAsync_HandlerThrows_ReportsInternalError()
    {
        // Arrange
        var handlers = new Dictionary<string, RpcHandler>(StringComparer.Ordinal)
        {
            ["boom"] = (_, _) => throw new InvalidOperationException("kaboom"),
        };

        // Act
        var lines = await RunServerAsync("{\"id\":3,\"method\":\"boom\"}\n", handlers);

        // Assert
        Assert.AreEqual("internalError", ErrorCodeOf(FindById(lines, 3)));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RunAsync_HandlerThrowsRpcException_ReportsItsCodeAndMessage()
    {
        // Arrange
        var handlers = new Dictionary<string, RpcHandler>(StringComparer.Ordinal)
        {
            ["denied"] = (_, _) => throw new RpcException("unauthorized", "Feed rejected the credentials."),
        };

        // Act
        var lines = await RunServerAsync("{\"id\":4,\"method\":\"denied\"}\n", handlers);

        // Assert
        var error = FindById(lines, 4).GetProperty("error");
        Assert.AreEqual("unauthorized", error.GetProperty("code").GetString());
        Assert.AreEqual("Feed rejected the credentials.", error.GetProperty("message").GetString());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RunAsync_ContextHandler_ReportsProgressBeforeTheResponse()
    {
        // Arrange — one context-aware handler and one plain handler share the server.
        var handlers = new Dictionary<string, RpcHandler>(StringComparer.Ordinal)
        {
            ["plain"] = (_, _) => Task.FromResult<object?>(new { ok = true }),
        };
        var contextHandlers = new Dictionary<string, ContextRpcHandler>(StringComparer.Ordinal)
        {
            ["reports"] = async (_, context, _) =>
            {
                Assert.AreEqual(42L, context.RequestId);
                await context.ReportProgressAsync("Parsing projects (1/2)…", 50, 1, 2).ConfigureAwait(false);
                return new { done = true };
            },
        };
        const string Input = "{\"id\":42,\"method\":\"reports\"}\n{\"id\":43,\"method\":\"plain\"}\n";

        // Act
        var lines = await RunServerAsync(Input, handlers, contextHandlers);

        // Assert — one progress line, carrying the request id and the reported fields.
        var progressLines = lines.Where(IsProgress).ToList();
        Assert.AreEqual(1, progressLines.Count);
        var progress = progressLines[0];
        Assert.AreEqual(42L, progress.GetProperty("id").GetInt64());
        Assert.AreEqual("Parsing projects (1/2)…", progress.GetProperty("stage").GetString());
        Assert.AreEqual(50, progress.GetProperty("percent").GetInt32());
        Assert.AreEqual(1, progress.GetProperty("completed").GetInt32());
        Assert.AreEqual(2, progress.GetProperty("total").GetInt32());

        // Assert — progress does not settle the request; the response still arrives.
        Assert.IsTrue(FindById(lines, 42).GetProperty("ok").GetBoolean());
        Assert.IsTrue(FindById(lines, 42).GetProperty("value").GetProperty("done").GetBoolean());

        // Assert — the progress line is written before the response for the same id.
        Assert.IsTrue(
            lines.FindIndex(IsProgress) < lines.FindIndex(line => IsResponse(line)
                && line.GetProperty("id").GetInt64() == 42),
            "the progress line must precede the response it belongs to.");

        // Assert — a plain handler in the same server is unaffected.
        Assert.IsTrue(FindById(lines, 43).GetProperty("ok").GetBoolean());
        Assert.IsTrue(FindById(lines, 43).GetProperty("value").GetProperty("ok").GetBoolean());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RunAsync_ContextHandlerThrows_ReportsInternalError()
    {
        // Arrange — regression: the context path answers with an error instead of dropping the request.
        var contextHandlers = new Dictionary<string, ContextRpcHandler>(StringComparer.Ordinal)
        {
            ["boom"] = (_, _, _) => throw new InvalidOperationException("kaboom"),
        };

        // Act
        var lines = await RunServerAsync("{\"id\":5,\"method\":\"boom\"}\n", handlers: null, contextHandlers);

        // Assert
        var response = FindById(lines, 5);
        Assert.IsFalse(response.GetProperty("ok").GetBoolean());
        Assert.AreEqual("internalError", ErrorCodeOf(response));
        Assert.AreEqual(0, lines.Count(IsProgress));
    }

    private static async Task<List<JsonElement>> RunServerAsync(
        string input,
        IReadOnlyDictionary<string, RpcHandler>? handlers = null,
        IReadOnlyDictionary<string, ContextRpcHandler>? contextHandlers = null)
    {
        using var reader = new StringReader(input);
        using var output = new StringWriter();
        using var error = new StringWriter();
        using var server = new NdjsonServer(reader, output, error, handlers, contextHandlers);

        await server.RunAsync(CancellationToken.None).ConfigureAwait(false);

        var messages = new List<JsonElement>();
        foreach (var line in output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            using var document = JsonDocument.Parse(line.Trim());
            messages.Add(document.RootElement.Clone());
        }

        return messages;
    }

    private static JsonElement FindById(IEnumerable<JsonElement> lines, long id) =>
        lines.Single(line =>
            IsResponse(line)
            && line.TryGetProperty("id", out var value)
            && value.TryGetInt64(out var actual)
            && actual == id);

    private static bool IsProgress(JsonElement line) =>
        line.TryGetProperty("type", out var type) && type.GetString() == "progress";

    private static bool IsResponse(JsonElement line) =>
        line.TryGetProperty("ok", out _) && !IsProgress(line);

    private static string ErrorCodeOf(JsonElement response) =>
        response.GetProperty("error").GetProperty("code").GetString() ?? string.Empty;
}
