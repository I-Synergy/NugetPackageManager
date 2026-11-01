using System.Collections.Concurrent;
using NugetPackageManager.Core.NuGet.Models;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>Hands out one source instance per URL, as the TypeScript factory does.</summary>
public interface INuGetSourceProvider
{
    INuGetSource GetSource(SourceDescriptor source);

    /// <summary>Drops cached package metadata on every source, for one id or (null) for all.</summary>
    void ClearPackageCaches(string? packageId = null);

    /// <summary>Drops a cached source (all of them when <paramref name="url"/> is null).</summary>
    void Clear(string? url = null);
}

/// <summary>
/// Caches one <see cref="ProtocolNuGetSource"/> per source URL so the service index and the
/// resource graph are resolved once instead of on every call. A provider is owned by the
/// sidecar's handler set and disposed with it.
/// </summary>
public sealed class NuGetSourceProvider : INuGetSourceProvider, IDisposable
{
    private readonly ConcurrentDictionary<string, ProtocolNuGetSource> sources = new(StringComparer.Ordinal);
    private readonly Func<SourceDescriptor, ProtocolNuGetSource> factory;

    public NuGetSourceProvider()
        : this(source => new ProtocolNuGetSource(source))
    {
    }

    /// <summary>Test seam: lets a suite supply a source backed by fake resources.</summary>
    public NuGetSourceProvider(Func<SourceDescriptor, ProtocolNuGetSource> factory)
    {
        ArgumentNullException.ThrowIfNull(factory);
        this.factory = factory;
    }

    public INuGetSource GetSource(SourceDescriptor source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return sources.GetOrAdd(source.Url, _ => factory(source));
    }

    public void ClearPackageCaches(string? packageId = null)
    {
        foreach (var source in sources.Values)
        {
            source.ClearPackageCache(packageId);
        }
    }

    public void Clear(string? url = null)
    {
        if (url is null)
        {
            foreach (var source in sources.Values)
            {
                source.Dispose();
            }

            sources.Clear();
            return;
        }

        if (sources.TryRemove(url, out var removed))
        {
            removed.Dispose();
        }
    }

    public void Dispose() => Clear();
}
