namespace NugetPackageManager.Common;

/// <summary>The lexical token kinds the MSBuild-condition parser produces.</summary>
public enum TokenType
{
    /// <summary><c>!</c></summary>
    Not,

    /// <summary><c>(</c></summary>
    LeftParen,

    /// <summary><c>)</c></summary>
    RightParen,

    /// <summary>The <c>And</c> keyword.</summary>
    And,

    /// <summary>The <c>Or</c> keyword.</summary>
    Or,

    /// <summary><c>==</c></summary>
    Equal,

    /// <summary><c>!=</c></summary>
    NotEqual,

    /// <summary>A quoted string literal.</summary>
    StringValue,

    /// <summary>A <c>$(Property)</c> reference.</summary>
    Property,

    /// <summary>A property function call, e.g. <c>$(TargetFramework.StartsWith('net8.0'))</c>.</summary>
    Call,

    /// <summary>A bare identifier.</summary>
    Identifier,
}
