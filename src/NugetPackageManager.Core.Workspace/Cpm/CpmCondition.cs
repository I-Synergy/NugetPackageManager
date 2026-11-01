using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.RegularExpressions;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// Parser and evaluator for the subset of MSBuild condition syntax that
/// <c>Directory.Packages.props</c> files use to scope a package version to a target framework.
///
/// Supported: <c>$(TargetFramework.StartsWith('net11.0'))</c>, <c>!(...)</c>,
/// <c>'$(TargetFramework)' == 'net10.0'</c>, <c>$(TargetFramework.Contains('-windows'))</c>,
/// <c>And</c> / <c>Or</c> and parentheses. Anything outside the grammar yields "unknown"
/// rather than a guess: callers must treat an unknown group as not attributable to a TFM.
/// </summary>
public static partial class CpmCondition
{
    [GeneratedRegex(@"^([a-z_][\w.-]*)\.(StartsWith|EndsWith|Contains)\(\s*(['""])(.*?)\3\s*\)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PropertyFunctionRegex();

    [GeneratedRegex(@"^[A-Za-z_][\w.-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex PropertyNameRegex();

    [GeneratedRegex(@"^\$\(([^)]+)\)$", RegexOptions.CultureInvariant)]
    private static partial Regex PropertyReferenceRegex();

    [GeneratedRegex(@"^net(\d+)\.\d+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TfmMajorRegex();

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WhitespaceRegex();

    /// <summary>Parses a condition; an empty condition is "always true".</summary>
    public static IConditionNode? Parse(string? condition)
    {
        var raw = (condition ?? string.Empty).Trim();
        if (raw.Length == 0)
        {
            return new LiteralNode(true);
        }

        var tokens = Tokenize(raw);
        return tokens is null || tokens.Count == 0 ? null : new ConditionParser(tokens).ParseExpression();
    }

    /// <summary>
    /// Tri-state evaluation: <c>true</c>/<c>false</c> when the expression can be decided,
    /// <c>null</c> when it cannot.
    /// </summary>
    public static bool? Evaluate(string? condition, IReadOnlyDictionary<string, string> properties)
    {
        ArgumentNullException.ThrowIfNull(properties);

        var ast = Parse(condition);
        if (ast is null)
        {
            return null;
        }

        var normalized = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (key, value) in properties)
        {
            normalized[key] = value;
        }

        return EvaluateNode(ast, normalized);
    }

    /// <summary>Human label for a condition, with negation made explicit.</summary>
    public static string GetLabel(string? condition)
    {
        var raw = (condition ?? string.Empty).Trim();
        if (raw.Length == 0)
        {
            return string.Empty;
        }

        var ast = Parse(raw);
        return ast is null ? FallbackLabel(raw) : LabelNode(ast) ?? FallbackLabel(raw);
    }

    /// <summary>Major version of a TFM (<c>net10.0-windows</c> → 10); null for e.g. netstandard2.0.</summary>
    public static int? GetTfmMajorVersion(string? tfm)
    {
        var match = TfmMajorRegex().Match((tfm ?? string.Empty).Trim());
        return match.Success
            ? int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture)
            : null;
    }

    private static bool? EvaluateNode(IConditionNode node, IReadOnlyDictionary<string, string> properties)
    {
        if (node is LiteralNode literal)
        {
            return literal.Value;
        }

        if (node is NotNode not)
        {
            return EvaluateNode(not.Operand, properties) is { } value ? !value : null;
        }

        if (node is AndNode and)
        {
            return EvaluateAnd(and, properties);
        }

        if (node is OrNode or)
        {
            return EvaluateOr(or, properties);
        }

        if (node is PropertyNode property)
        {
            return EvaluateProperty(property, properties);
        }

        if (node is CompareNode compare)
        {
            return EvaluateCompare(compare, properties);
        }

        return node is CallNode call ? EvaluateCall(call, properties) : null;
    }

    private static bool? EvaluateAnd(AndNode node, IReadOnlyDictionary<string, string> properties)
    {
        var left = EvaluateNode(node.Left, properties);
        var right = EvaluateNode(node.Right, properties);

        if (left == false || right == false)
        {
            return false;
        }

        return left is null || right is null ? null : true;
    }

    private static bool? EvaluateOr(OrNode node, IReadOnlyDictionary<string, string> properties)
    {
        var left = EvaluateNode(node.Left, properties);
        var right = EvaluateNode(node.Right, properties);

        if (left == true || right == true)
        {
            return true;
        }

        return left is null || right is null ? null : false;
    }

    private static bool? EvaluateProperty(PropertyNode node, IReadOnlyDictionary<string, string> properties)
    {
        if (!properties.TryGetValue(node.Name, out var value))
        {
            return null;
        }

        var lower = value.Trim();
        if (string.Equals(lower, "true", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return lower.Length == 0 || string.Equals(lower, "false", StringComparison.OrdinalIgnoreCase)
            ? false
            : null;
    }

    private static bool? EvaluateCompare(CompareNode node, IReadOnlyDictionary<string, string> properties)
    {
        var left = ResolveOperand(node.Property, properties);
        var right = ResolveOperand(node.Value, properties);

        if (left is null || right is null)
        {
            return null;
        }

        var equal = string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        return node.Operator == "==" ? equal : !equal;
    }

    private static bool? EvaluateCall(CallNode node, IReadOnlyDictionary<string, string> properties)
    {
        if (!properties.TryGetValue(node.Property, out var value))
        {
            return null;
        }

        var haystack = value.ToLowerInvariant();
        var needle = node.Value.ToLowerInvariant();

        return node.Method switch
        {
            "startswith" => haystack.StartsWith(needle, StringComparison.Ordinal),
            "endswith" => haystack.EndsWith(needle, StringComparison.Ordinal),
            "contains" => haystack.Contains(needle, StringComparison.Ordinal),
            _ => null,
        };
    }

    private static string? ResolveOperand(string value, IReadOnlyDictionary<string, string> properties)
    {
        var match = PropertyReferenceRegex().Match(value.Trim());
        if (!match.Success)
        {
            return value;
        }

        return properties.TryGetValue(match.Groups[1].Value.Trim(), out var resolved) ? resolved : null;
    }

    private static string? LabelNode(IConditionNode node)
    {
        if (node is LiteralNode literal)
        {
            return literal.Value ? "always" : "never";
        }

        if (node is NotNode not)
        {
            return LabelNode(not.Operand) is { } inner ? $"not {inner}" : null;
        }

        if (node is AndNode and)
        {
            return LabelBinary(and.Left, and.Right, "and");
        }

        if (node is OrNode or)
        {
            return LabelBinary(or.Left, or.Right, "or");
        }

        if (node is CompareNode compare)
        {
            return LabelCompare(compare);
        }

        return node is CallNode call ? call.Value : null;
    }

    private static string? LabelBinary(IConditionNode left, IConditionNode right, string joiner)
    {
        var leftLabel = LabelNode(left);
        var rightLabel = LabelNode(right);
        return leftLabel is not null && rightLabel is not null ? $"{leftLabel} {joiner} {rightLabel}" : null;
    }

    private static string? LabelCompare(CompareNode node)
    {
        if (node.Value.StartsWith("$(", StringComparison.Ordinal))
        {
            return null;
        }

        return node.Operator == "==" ? node.Value : $"not {node.Value}";
    }

    private static string FallbackLabel(string raw)
    {
        var withoutSyntax = raw
            .Replace("$", string.Empty, StringComparison.Ordinal)
            .Replace("(", string.Empty, StringComparison.Ordinal)
            .Replace(")", string.Empty, StringComparison.Ordinal)
            .Replace("'", string.Empty, StringComparison.Ordinal)
            .Replace("\"", string.Empty, StringComparison.Ordinal);

        var collapsed = WhitespaceRegex().Replace(withoutSyntax, " ").Trim();
        return collapsed.Length <= 40 ? collapsed : collapsed[..40];
    }

    private sealed record Token(TokenType Type, string Text = "", string Method = "", string Property = "");

    private static List<Token>? Tokenize(string input)
    {
        var tokens = new List<Token>();
        var index = 0;

        while (index < input.Length)
        {
            SkipWhitespace(input, ref index);
            if (index >= input.Length)
            {
                break;
            }

            var token = ReadToken(input, ref index);
            if (token is null)
            {
                return null;
            }

            tokens.Add(token);
        }

        return tokens;
    }

    private static void SkipWhitespace(string input, ref int index)
    {
        while (index < input.Length && char.IsWhiteSpace(input[index]))
        {
            index++;
        }
    }

    /// <summary>The next token, or null when the input is malformed.</summary>
    private static Token? ReadToken(string input, ref int index)
    {
        if (TryReadSymbol(input, ref index, out var symbol))
        {
            return symbol;
        }

        var current = input[index];
        if (current is '\'' or '"')
        {
            var quoted = ReadQuoted(input, ref index, current);
            return quoted is null ? null : ClassifyValue(quoted);
        }

        if (current == '$' && index + 1 < input.Length && input[index + 1] == '(')
        {
            var expression = ReadPropertyExpression(input, ref index);
            return expression is null ? null : ClassifyPropertyExpression(expression);
        }

        var word = ReadWord(input, ref index);
        return word is null ? null : KeywordToken(word);
    }

    private static Token KeywordToken(string word)
    {
        if (string.Equals(word, "and", StringComparison.OrdinalIgnoreCase))
        {
            return new Token(TokenType.And);
        }

        return string.Equals(word, "or", StringComparison.OrdinalIgnoreCase)
            ? new Token(TokenType.Or)
            : new Token(TokenType.Identifier, word);
    }

    private static bool TryReadSymbol(string input, ref int index, [NotNullWhen(true)] out Token? token)
    {
        token = null;

        if (Matches(input, index, "!="))
        {
            index += 2;
            token = new Token(TokenType.NotEqual);
            return true;
        }

        if (Matches(input, index, "=="))
        {
            index += 2;
            token = new Token(TokenType.Equal);
            return true;
        }

        switch (input[index])
        {
            case '!':
                index++;
                token = new Token(TokenType.Not);
                return true;
            case '(':
                index++;
                token = new Token(TokenType.LeftParen);
                return true;
            case ')':
                index++;
                token = new Token(TokenType.RightParen);
                return true;
            default:
                return false;
        }
    }

    private static bool Matches(string input, int index, string value) =>
        index + value.Length <= input.Length
        && string.CompareOrdinal(input, index, value, 0, value.Length) == 0;

    private static string? ReadQuoted(string input, ref int index, char quote)
    {
        index++;
        var start = index;

        while (index < input.Length)
        {
            if (input[index] == quote)
            {
                var value = input[start..index];
                index++;
                return value;
            }

            index++;
        }

        return null;
    }

    private static string? ReadPropertyExpression(string input, ref int index)
    {
        index += 2; // "$("
        var start = index;
        var depth = 1;
        char? quote = null;

        while (index < input.Length)
        {
            var current = input[index];

            if (quote is not null)
            {
                if (current == quote)
                {
                    quote = null;
                }
            }
            else if (current is '\'' or '"')
            {
                quote = current;
            }
            else if (current == '(')
            {
                depth++;
            }
            else if (current == ')')
            {
                depth--;
                if (depth == 0)
                {
                    var value = input[start..index];
                    index++;
                    return value;
                }
            }

            index++;
        }

        return null;
    }

    private static string? ReadWord(string input, ref int index)
    {
        var start = index;

        while (index < input.Length)
        {
            var current = input[index];
            if (char.IsWhiteSpace(current)
                || current is '(' or ')' or '!' or '\'' or '"')
            {
                break;
            }

            index++;
        }

        return index > start ? input[start..index] : null;
    }

    private static Token ClassifyValue(string value)
    {
        var trimmed = value.Trim();
        var match = PropertyReferenceRegex().Match(trimmed);
        return match.Success
            ? new Token(TokenType.Property, match.Groups[1].Value.Trim())
            : new Token(TokenType.StringValue, trimmed);
    }

    private static Token ClassifyPropertyExpression(string value)
    {
        var functionMatch = PropertyFunctionRegex().Match(value);
        if (functionMatch.Success)
        {
            return new Token(
                TokenType.Call,
                functionMatch.Groups[4].Value,
                functionMatch.Groups[2].Value.ToLowerInvariant(),
                functionMatch.Groups[1].Value);
        }

        return PropertyNameRegex().IsMatch(value.Trim())
            ? new Token(TokenType.Property, value.Trim())
            : new Token(TokenType.Identifier, value);
    }

    private sealed class ConditionParser(IReadOnlyList<Token> tokens)
    {
        private int index;

        public IConditionNode? ParseExpression()
        {
            var expression = ParseOr();
            return expression is not null && index == tokens.Count ? expression : null;
        }

        private Token? Peek() => index < tokens.Count ? tokens[index] : null;

        private IConditionNode? ParseOr()
        {
            var left = ParseAnd();
            if (left is null)
            {
                return null;
            }

            while (Peek()?.Type == TokenType.Or)
            {
                index++;
                var right = ParseAnd();
                if (right is null)
                {
                    return null;
                }

                left = new OrNode(left, right);
            }

            return left;
        }

        private IConditionNode? ParseAnd()
        {
            var left = ParseUnary();
            if (left is null)
            {
                return null;
            }

            while (Peek()?.Type == TokenType.And)
            {
                index++;
                var right = ParseUnary();
                if (right is null)
                {
                    return null;
                }

                left = new AndNode(left, right);
            }

            return left;
        }

        private IConditionNode? ParseUnary()
        {
            if (Peek()?.Type == TokenType.Not)
            {
                index++;
                var operand = ParseUnary();
                return operand is null ? null : new NotNode(operand);
            }

            return ParsePrimary();
        }

        private IConditionNode? ParsePrimary()
        {
            var token = Peek();
            if (token is null)
            {
                return null;
            }

            if (token.Type == TokenType.LeftParen)
            {
                return ParseParenthesized();
            }

            if (token.Type == TokenType.Call)
            {
                return ParseCall(token);
            }

            return token.Type is TokenType.Property or TokenType.StringValue ? ParseValue(token) : null;
        }

        private IConditionNode? ParseParenthesized()
        {
            index++;
            var expression = ParseOr();
            if (expression is null || Peek()?.Type != TokenType.RightParen)
            {
                return null;
            }

            index++;
            return expression;
        }

        private CallNode ParseCall(Token token)
        {
            index++;
            return new CallNode(token.Property, token.Method, token.Text);
        }

        private IConditionNode? ParseValue(Token token)
        {
            index++;
            var next = Peek();

            if (next?.Type is TokenType.Equal or TokenType.NotEqual)
            {
                return ParseComparison(token, next);
            }

            if (token.Type == TokenType.Property)
            {
                return new PropertyNode(token.Text);
            }

            return ParseLiteral(token.Text);
        }

        private CompareNode? ParseComparison(Token token, Token comparison)
        {
            index++;
            var right = Peek();
            if (right is null || right.Type is not (TokenType.StringValue or TokenType.Property))
            {
                return null;
            }

            index++;

            return new CompareNode(
                token.Type == TokenType.Property ? $"$({token.Text})" : token.Text,
                comparison.Type == TokenType.Equal ? "==" : "!=",
                right.Type == TokenType.StringValue ? right.Text : $"$({right.Text})");
        }

        private static LiteralNode? ParseLiteral(string value)
        {
            var lower = value.Trim();

            if (string.Equals(lower, "true", StringComparison.OrdinalIgnoreCase))
            {
                return new LiteralNode(true);
            }

            return string.Equals(lower, "false", StringComparison.OrdinalIgnoreCase)
                ? new LiteralNode(false)
                : null;
        }
    }
}
