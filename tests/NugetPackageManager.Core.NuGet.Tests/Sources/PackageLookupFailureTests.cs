// File: tests/NugetPackageManager.Core.NuGet.Tests/Sources/PackageLookupFailureTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// A 404 on the registration index means the package id does not exist, not that the feed is
// down: the host maps only "packageNotFound" to its friendly message.

using System.Net;
using System.Text;
using NugetPackageManager.Core.NuGet.Models;
using NugetPackageManager.Core.NuGet.Sources;

namespace NugetPackageManager.Core.NuGet.Tests.Sources;

[TestClass]
public class PackageLookupFailureTests
{
    private const string SourceUrl = "https://example.test/v3/index.json";

    private const string ServiceIndex = """
        {
          "version": "3.0.0",
          "resources": [
            { "@id": "https://example.test/v3/search", "@type": "SearchQueryService" },
            { "@id": "https://example.test/v3/registration/", "@type": "RegistrationsBaseUrl/3.6.0" }
          ]
        }
        """;

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_MissingPackage_ReportsPackageNotFound()
    {
        using var source = CreateSource();

        var error = await Assert.ThrowsExactlyAsync<NuGetSourceException>(
            () => source.GetPackageAsync("does.not.exist", prerelease: false, CancellationToken.None));

        Assert.AreEqual("packageNotFound", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task SearchAsync_NotFound_StillReportsSourceUnreachable()
    {
        using var source = CreateSource();

        var error = await Assert.ThrowsExactlyAsync<NuGetSourceException>(
            () => source.SearchAsync("anything", prerelease: false, skip: 0, take: 5, CancellationToken.None));

        Assert.AreEqual("sourceUnreachable", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_ServerError_StillReportsSourceUnreachable()
    {
        using var source = CreateSource(status: HttpStatusCode.InternalServerError);

        var error = await Assert.ThrowsExactlyAsync<NuGetSourceException>(
            () => source.GetPackageAsync("Newtonsoft.Json", prerelease: false, CancellationToken.None));

        Assert.AreEqual("sourceUnreachable", error.Code);
    }

    private static HttpNuGetSource CreateSource(HttpStatusCode status = HttpStatusCode.NotFound) =>
        new(new SourceDescriptor { Url = SourceUrl }, new StubHandler(status));

    private sealed class StubHandler(HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            _ = cancellationToken;

            // The service index always resolves; everything it points at answers with `status`.
            if (string.Equals(request.RequestUri?.AbsoluteUri, SourceUrl, StringComparison.Ordinal))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(ServiceIndex, Encoding.UTF8, "application/json"),
                });
            }

            return Task.FromResult(new HttpResponseMessage(status));
        }
    }
}
