using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>
/// Minimal JSON-over-HTTP client for a NuGet v3 feed.
///
/// The proxy is supplied by the host (VS Code's <c>http.proxy</c> or the environment) rather
/// than discovered here, so the sidecar never picks its own network path. Credentials are
/// decided per request by the caller, which is what keeps them off untrusted hosts.
/// </summary>
public sealed class NuGetHttpClient : IDisposable
{
    private readonly HttpClient client;

    public NuGetHttpClient(string? proxyUrl = null, HttpMessageHandler? handler = null)
    {
        var messageHandler = handler ?? CreateHandler(proxyUrl);
        client = new HttpClient(messageHandler, disposeHandler: true);
        client.Timeout = TimeSpan.FromSeconds(120);
    }

    public async Task<JsonDocument> GetJsonAsync(
        string url,
        CancellationToken cancellationToken,
        Func<Uri, AuthenticationHeaderValue?>? authorizationFor = null)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            throw new NuGetSourceException("invalidParams", $"'{url}' is not an absolute URL.");
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, uri);

        var authorization = authorizationFor?.Invoke(uri);
        if (authorization is not null)
        {
            request.Headers.Authorization = authorization;
        }

        using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new NuGetSourceException(
                "unauthorized",
                $"'{uri.Host}' rejected the credentials ({(int)response.StatusCode}).");
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new NuGetSourceException(
                "sourceUnreachable",
                $"'{uri}' returned {(int)response.StatusCode} {response.ReasonPhrase}.");
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    public void Dispose() => client.Dispose();

    private static HttpClientHandler CreateHandler(string? proxyUrl)
    {
        // NuGet.org's `registration5-gz-*` resources are gzip-encoded, and HttpClient does not
        // decompress unless asked. Without this the JSON parser sees the 0x1F magic byte.
        var primary = new HttpClientHandler
        {
            AutomaticDecompression =
                DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
        };

        if (!string.IsNullOrWhiteSpace(proxyUrl) && Uri.TryCreate(proxyUrl, UriKind.Absolute, out var proxy))
        {
            primary.Proxy = new WebProxy(proxy);
            primary.UseProxy = true;
        }

        return primary;
    }
}
