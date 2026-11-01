namespace NugetPackageManager.Common;

/// <summary>Where a CPM write is allowed to land.</summary>
public enum CpmWriteScope
{
    /// <summary>The <c>ItemGroup</c> whose combined condition matches.</summary>
    Group,

    /// <summary>Every unconditional <c>ItemGroup</c>.</summary>
    Unconditional,

    /// <summary>Every occurrence, conditional or not.</summary>
    All,

    /// <summary>Only the first matching element.</summary>
    First,
}
