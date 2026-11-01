using NuGet.Configuration;
using NuGet.Protocol;
using NuGet.Protocol.Core.Types;
using NugetPackageManager.Core.NuGet.Models;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>Builds the NuGet.Protocol repository for one resolved source.</summary>
public static class SourceRepositoryFactory
{
    public static SourceRepository Create(SourceDescriptor source)
    {
        ArgumentNullException.ThrowIfNull(source);

        var packageSource = new PackageSource(source.Url);

        if (!string.IsNullOrEmpty(source.Password))
        {
            packageSource.Credentials = new PackageSourceCredential(
                source.Url,
                source.Username ?? string.Empty,
                source.Password,
                isPasswordClearText: true,
                validAuthenticationTypesText: null);
        }

        return Repository.Factory.GetCoreV3(packageSource);
    }
}
