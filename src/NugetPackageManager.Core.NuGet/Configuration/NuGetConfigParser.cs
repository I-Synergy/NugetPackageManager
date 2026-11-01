using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>
/// Parses one <c>nuget.config</c> file into the parts the resolver merges.
///
/// Hand-rolled on purpose: <c>NuGet.Configuration</c> expands <c>%VAR%</c> on every level, and a
/// workspace config must never be able to read the developer's environment and send it to a feed
/// it controls. Expansion is therefore a per-file decision, applied only above workspace level.
/// </summary>
public static partial class NuGetConfigParser
{
    private const string UsernameKey = "Username";
    private const string ClearTextPasswordKey = "ClearTextPassword";
    private const string PasswordKey = "Password";

    /// <summary>Parses the file's text. Malformed XML throws <see cref="XmlException"/>; the resolver reports it.</summary>
    public static NuGetConfigFile Parse(string content, bool expandEnvironment, Func<string, string?>? getVariable = null)
    {
        ArgumentNullException.ThrowIfNull(content);

        var document = XDocument.Parse(content);
        var sources = new List<NuGetConfigSource>();
        var credentials = new Dictionary<string, NuGetConfigCredential>(StringComparer.Ordinal);
        var disabled = new List<string>();
        var mappings = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);

        var clear = Element(document, "packageSources", "clear") is not null;

        foreach (var add in Elements(document, "packageSources", "add"))
        {
            var name = Attribute(add, "key");
            var url = Attribute(add, "value");

            if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(url))
            {
                sources.Add(new NuGetConfigSource(name, url));
            }
        }

        foreach (var add in Elements(document, "disabledPackageSources", "add"))
        {
            var name = Attribute(add, "key");
            if (!string.IsNullOrEmpty(name) && string.Equals(Attribute(add, "value"), "true", StringComparison.OrdinalIgnoreCase))
            {
                disabled.Add(name);
            }
        }

        foreach (var container in Descendants(document, "packageSourceCredentials"))
        {
            foreach (var sourceElement in container.Elements())
            {
                var parsed = ParseCredential(sourceElement, expandEnvironment, getVariable);
                if (parsed is not null)
                {
                    credentials[parsed.Value.Name] = parsed.Value.Credential;
                }
            }
        }

        var clearMappings = Element(document, "packageSourceMapping", "clear") is not null;
        foreach (var packageSource in Elements(document, "packageSourceMapping", "packageSource"))
        {
            var key = Attribute(packageSource, "key");
            if (string.IsNullOrEmpty(key))
            {
                continue;
            }

            var patterns = packageSource
                .Descendants()
                .Where(element => element.Name.LocalName == "package")
                .Select(element => Attribute(element, "pattern"))
                .Where(pattern => !string.IsNullOrEmpty(pattern))
                .Select(pattern => pattern!)
                .ToArray();

            if (patterns.Length > 0)
            {
                mappings[key] = patterns;
            }
        }

        return new NuGetConfigFile(sources, credentials, disabled, clear, mappings, clearMappings);
    }

    /// <summary>
    /// NuGet encodes characters that are invalid in XML element names as <c>_xHHHH_</c>, so
    /// <c>rfh/nuget</c> is stored as <c>rfh_x002F_nuget</c>. Decode the source name back.
    /// </summary>
    public static string DecodeXmlName(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        return EscapedName().Replace(name, match => char.ConvertFromUtf32(int.Parse(match.Groups[1].Value, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture)));
    }

    private static (string Name, NuGetConfigCredential Credential)? ParseCredential(
        XElement sourceElement,
        bool expandEnvironment,
        Func<string, string?>? getVariable)
    {
        var name = DecodeXmlName(sourceElement.Name.LocalName);
        var user = ChildValue(sourceElement, UsernameKey);
        var authToken = ChildValue(sourceElement, ClearTextPasswordKey) ?? ChildValue(sourceElement, PasswordKey);

        // Never expand values from a workspace-level config: the repository would be able to read
        // the developer's environment and send it to a feed it controls.
        if (!string.IsNullOrEmpty(authToken) && expandEnvironment && getVariable is not null)
        {
            authToken = EnvironmentReference().Replace(authToken, match => getVariable(match.Groups[1].Value) ?? string.Empty);
        }

        if (string.IsNullOrEmpty(user) && string.IsNullOrEmpty(authToken))
        {
            return null;
        }

        return (name, new NuGetConfigCredential(
            string.IsNullOrEmpty(user) ? null : user,
            string.IsNullOrEmpty(authToken) ? null : authToken));
    }

    /// <summary>Reads <c>add[@key='...']/@value</c> from the element's direct children.</summary>
    private static string? ChildValue(XElement parent, string key) =>
        parent.Elements()
            .Where(element => element.Name.LocalName == "add"
                && string.Equals(Attribute(element, "key"), key, StringComparison.Ordinal))
            .Select(element => Attribute(element, "value"))
            .FirstOrDefault(value => !string.IsNullOrEmpty(value));

    private static string? Attribute(XElement element, string name) =>
        element.Attributes().FirstOrDefault(attribute => attribute.Name.LocalName == name)?.Value;

    private static IEnumerable<XElement> Descendants(XDocument document, string localName) =>
        document.Descendants().Where(element => element.Name.LocalName == localName);

    private static XElement? Element(XDocument document, string parent, string child) =>
        Descendants(document, parent)
            .SelectMany(parentElement => parentElement.Elements())
            .FirstOrDefault(element => element.Name.LocalName == child);

    private static IEnumerable<XElement> Elements(XDocument document, string parent, string child) =>
        Descendants(document, parent)
            .SelectMany(parentElement => parentElement.Elements())
            .Where(element => element.Name.LocalName == child);

    [GeneratedRegex("_x([0-9A-Fa-f]{4})_")]
    private static partial Regex EscapedName();

    [GeneratedRegex("%([^%]+)%")]
    private static partial Regex EnvironmentReference();
}
