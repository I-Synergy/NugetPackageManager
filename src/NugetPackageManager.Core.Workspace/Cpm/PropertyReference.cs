using System.Text.RegularExpressions;

namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// Recognises a value that is nothing but a whole-value property reference, for example
/// <c>$(FooBarVersion)</c>. Anything else — a prefix, a suffix, two references, a concatenation —
/// is not a reference the writer can safely translate into a property edit.
/// </summary>
public static partial class PropertyReference
{
    /// <summary>The referenced property name, or <c>null</c> when the value is not a pure reference.</summary>
    public static string? GetPropertyName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var match = ReferenceRegex().Match(value);
        return match.Success ? match.Groups[1].Value : null;
    }

    [GeneratedRegex(@"^\s*\$\(([A-Za-z_][A-Za-z0-9_-]*)\)\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex ReferenceRegex();
}
