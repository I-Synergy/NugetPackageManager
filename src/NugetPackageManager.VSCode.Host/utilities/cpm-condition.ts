/**
 * Parser and evaluator for the subset of MSBuild condition syntax used by
 * `Directory.Packages.props` files to scope package versions to target frameworks.
 *
 * Supported:
 *   $(TargetFramework.StartsWith('net11.0'))
 *   !$(TargetFramework.StartsWith('net11.0'))
 *   '$(TargetFramework)' == 'net10.0'
 *   '$(TargetFramework)' != 'net10.0'
 *   $(TargetFramework.Contains('-windows'))
 *   <expr> And <expr> / <expr> Or <expr> / ( <expr> )
 *
 * Anything outside this grammar yields `unknown` when evaluated; callers must
 * treat unknown groups as "not attributable to a TFM" rather than guessing.
 */

export type CpmConditionAst =
  | { kind: "literal"; value: boolean }
  | { kind: "not"; operand: CpmConditionAst }
  | { kind: "and"; left: CpmConditionAst; right: CpmConditionAst }
  | { kind: "or"; left: CpmConditionAst; right: CpmConditionAst }
  | { kind: "compare"; property: string; operator: "==" | "!="; value: string }
  | { kind: "call"; property: string; method: "startswith" | "endswith" | "contains"; value: string }
  | { kind: "property"; name: string };

type Token =
  | { type: "not" }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "and" }
  | { type: "or" }
  | { type: "eq" }
  | { type: "ne" }
  | { type: "string"; value: string }
  | { type: "property"; name: string }
  | { type: "call"; property: string; method: "startswith" | "endswith" | "contains"; value: string }
  | { type: "identifier"; value: string };

const PROPERTY_FUNCTION_RE =
  /^([a-z_][\w.-]*)\.(StartsWith|EndsWith|Contains)\(\s*(['"])(.*?)\3\s*\)$/i;
const PROPERTY_NAME_RE = /^[A-Za-z_][\w.-]*$/;

class Tokenizer {
  private index = 0;

  constructor(private readonly input: string) {}

  tokenize(): Token[] | null {
    const tokens: Token[] = [];
    while (this.index < this.input.length) {
      this.skipWhitespace();
      if (this.index >= this.input.length) break;
      const token = this.readNextToken();
      if (token === null) return null;
      if (token) tokens.push(token);
    }
    return tokens;
  }

  private readNextToken(): Token | null | undefined {
    const symbol = this.readSymbolToken();
    if (symbol) return symbol;

    const ch = this.input[this.index]!;
    if (ch === "'" || ch === '"') {
      const value = this.readQuoted(ch);
      return value === null ? null : this.classifyValue(value);
    }
    if (ch === "$" && this.input[this.index + 1] === "(") {
      const value = this.readPropertyExpression();
      return value === null ? null : this.classifyPropertyExpression(value);
    }
    return this.readWordToken();
  }

  private readSymbolToken(): Token | undefined {
    if (this.input.startsWith("!=", this.index)) {
      this.index += 2;
      return { type: "ne" };
    }
    if (this.input.startsWith("==", this.index)) {
      this.index += 2;
      return { type: "eq" };
    }
    switch (this.input[this.index]) {
      case "!":
        this.index++;
        return { type: "not" };
      case "(":
        this.index++;
        return { type: "lparen" };
      case ")":
        this.index++;
        return { type: "rparen" };
      default:
        return undefined;
    }
  }

  private readWordToken(): Token | null {
    const word = this.readWord();
    if (word === null || word.length === 0) return null;
    const lower = word.toLowerCase();
    if (lower === "and") return { type: "and" };
    if (lower === "or") return { type: "or" };
    return { type: "identifier", value: word };
  }

  private skipWhitespace(): void {
    while (this.index < this.input.length && /\s/.test(this.input[this.index]!)) {
      this.index++;
    }
  }

  private readQuoted(quote: string): string | null {
    this.index++; // opening quote
    const start = this.index;
    while (this.index < this.input.length) {
      if (this.input[this.index] === quote) {
        const value = this.input.slice(start, this.index);
        this.index++;
        return value;
      }
      this.index++;
    }
    return null;
  }

  private readPropertyExpression(): string | null {
    this.index += 2; // "$("
    const start = this.index;
    let depth = 1;
    let quote: string | null = null;
    while (this.index < this.input.length) {
      const ch = this.input[this.index]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          const value = this.input.slice(start, this.index);
          this.index++;
          return value;
        }
      }
      this.index++;
    }
    return null;
  }

  private readWord(): string | null {
    const start = this.index;
    while (this.index < this.input.length) {
      const ch = this.input[this.index]!;
      if (/\s/.test(ch) || ch === "(" || ch === ")" || ch === "!" || ch === "'" || ch === '"') break;
      this.index++;
    }
    return this.index > start ? this.input.slice(start, this.index) : null;
  }

  private classifyValue(value: string): Token {
    const trimmed = value.trim();
    if (/^\$\(([^)]+)\)$/.test(trimmed)) {
      return { type: "property", name: trimmed.slice(2, -1).trim() };
    }
    return { type: "string", value: trimmed };
  }

  private classifyPropertyExpression(value: string): Token {
    const functionMatch = PROPERTY_FUNCTION_RE.exec(value);
    if (functionMatch) {
      return {
        type: "call",
        property: functionMatch[1]!,
        method: functionMatch[2]!.toLowerCase() as "startswith" | "endswith" | "contains",
        value: functionMatch[4]!,
      };
    }
    if (PROPERTY_NAME_RE.test(value.trim())) {
      return { type: "property", name: value.trim() };
    }
    return { type: "identifier", value };
  }
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): CpmConditionAst | null {
    const expr = this.parseOr();
    if (!expr || this.index !== this.tokens.length) return null;
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private parseOr(): CpmConditionAst | null {
    let left = this.parseAnd();
    if (!left) return null;
    while (this.peek()?.type === "or") {
      this.index++;
      const right = this.parseAnd();
      if (!right) return null;
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseAnd(): CpmConditionAst | null {
    let left = this.parseUnary();
    if (!left) return null;
    while (this.peek()?.type === "and") {
      this.index++;
      const right = this.parseUnary();
      if (!right) return null;
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseUnary(): CpmConditionAst | null {
    if (this.peek()?.type === "not") {
      this.index++;
      const operand = this.parseUnary();
      return operand ? { kind: "not", operand } : null;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): CpmConditionAst | null {
    const token = this.peek();
    if (!token) return null;
    if (token.type === "lparen") return this.parseParenthesized();
    if (token.type === "call") return this.parseCallToken(token);
    if (token.type === "property" || token.type === "string") return this.parseValueToken(token);
    return null;
  }

  private parseParenthesized(): CpmConditionAst | null {
    this.index++;
    const expr = this.parseOr();
    if (!expr || this.peek()?.type !== "rparen") return null;
    this.index++;
    return expr;
  }

  private parseCallToken(token: Token & { type: "call" }): CpmConditionAst {
    this.index++;
    return {
      kind: "call",
      property: token.property,
      method: token.method,
      value: token.value,
    };
  }

  private parseValueToken(token: Token & { type: "property" | "string" }): CpmConditionAst | null {
    this.index++;
    const next = this.peek();
    if (next?.type === "eq" || next?.type === "ne") {
      return this.parseComparisonToken(token, next);
    }
    if (token.type === "property") {
      return { kind: "property", name: token.name };
    }
    return this.parseLiteral(token.value);
  }

  private parseComparisonToken(
    token: Token & { type: "property" | "string" },
    operator: Token & { type: "eq" | "ne" }
  ): CpmConditionAst | null {
    this.index++;
    const right = this.peek();
    if (!right || (right.type !== "string" && right.type !== "property")) return null;
    this.index++;
    return {
      kind: "compare",
      property: token.type === "property" ? `$(${token.name})` : token.value,
      operator: operator.type === "eq" ? "==" : "!=",
      value: right.type === "string" ? right.value : `$(${right.name})`,
    };
  }

  private parseLiteral(value: string): CpmConditionAst | null {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return { kind: "literal", value: true };
    if (lower === "false") return { kind: "literal", value: false };
    return null;
  }
}

export function parseCondition(condition: string): CpmConditionAst | null {
  const raw = condition.trim();
  if (!raw) return { kind: "literal", value: true };

  const tokens = new Tokenizer(raw).tokenize();
  if (!tokens || tokens.length === 0) return null;

  return new Parser(tokens).parse();
}

/** Returns `true`/`false` when the expression can be evaluated, `null` when it cannot. */
export function evaluateCondition(
  condition: string,
  properties: Record<string, string>
): boolean | null {
  const ast = parseCondition(condition);
  if (!ast) return null;
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(properties)) {
    normalized.set(key.toLowerCase(), value);
  }
  return evaluateAst(ast, normalized);
}

function evaluateAst(ast: CpmConditionAst, properties: Map<string, string>): boolean | null {
  switch (ast.kind) {
    case "literal":
      return ast.value;
    case "not":
      return evaluateNot(ast, properties);
    case "and":
      return evaluateAnd(ast, properties);
    case "or":
      return evaluateOr(ast, properties);
    case "property":
      return evaluateProperty(ast, properties);
    case "compare":
      return evaluateCompare(ast, properties);
    case "call":
      return evaluateCall(ast, properties);
  }
}

function evaluateNot(ast: CpmConditionAst & { kind: "not" }, properties: Map<string, string>): boolean | null {
  const value = evaluateAst(ast.operand, properties);
  return value === null ? null : !value;
}

function evaluateAnd(ast: CpmConditionAst & { kind: "and" }, properties: Map<string, string>): boolean | null {
  const left = evaluateAst(ast.left, properties);
  const right = evaluateAst(ast.right, properties);
  if (left === false || right === false) return false;
  return left === null || right === null ? null : true;
}

function evaluateOr(ast: CpmConditionAst & { kind: "or" }, properties: Map<string, string>): boolean | null {
  const left = evaluateAst(ast.left, properties);
  const right = evaluateAst(ast.right, properties);
  if (left === true || right === true) return true;
  return left === null || right === null ? null : false;
}

function evaluateProperty(
  ast: CpmConditionAst & { kind: "property" },
  properties: Map<string, string>
): boolean | null {
  const value = properties.get(ast.name.toLowerCase());
  if (value === undefined) return null;
  const lower = value.trim().toLowerCase();
  if (lower === "true") return true;
  if (lower === "false" || lower === "") return false;
  return null;
}

function evaluateCompare(
  ast: CpmConditionAst & { kind: "compare" },
  properties: Map<string, string>
): boolean | null {
  const left = resolveOperand(ast.property, properties);
  const right = resolveOperand(ast.value, properties);
  if (left === null || right === null) return null;
  const equal = left.toLowerCase() === right.toLowerCase();
  return ast.operator === "==" ? equal : !equal;
}

function evaluateCall(ast: CpmConditionAst & { kind: "call" }, properties: Map<string, string>): boolean | null {
  const value = properties.get(ast.property.toLowerCase());
  if (value === undefined) return null;
  const haystack = value.toLowerCase();
  const needle = ast.value.toLowerCase();
  switch (ast.method) {
    case "startswith":
      return haystack.startsWith(needle);
    case "endswith":
      return haystack.endsWith(needle);
    case "contains":
      return haystack.includes(needle);
  }
}

function resolveOperand(value: string, properties: Map<string, string>): string | null {
  const match = /^\$\(([^)]+)\)$/.exec(value.trim());
  if (match) {
    return properties.get(match[1]!.trim().toLowerCase()) ?? null;
  }
  return value;
}

/**
 * Human label for a condition. Negation is made explicit so a negated and a
 * positive condition on the same TFM do not collapse to the same label.
 */
export function getConditionLabel(condition: string): string {
  const raw = condition.trim();
  if (!raw) return "";

  const ast = parseCondition(raw);
  if (!ast) return fallbackLabel(raw);

  const label = labelAst(ast);
  return label ?? fallbackLabel(raw);
}

function labelAst(ast: CpmConditionAst): string | null {
  switch (ast.kind) {
    case "literal":
      return ast.value ? "always" : "never";
    case "not":
      return labelNot(ast);
    case "and":
      return labelBinary(ast, "and");
    case "or":
      return labelBinary(ast, "or");
    case "compare":
      return labelCompare(ast);
    case "call":
      return ast.value;
    case "property":
      return null;
  }
}

function labelNot(ast: CpmConditionAst & { kind: "not" }): string | null {
  const inner = labelAst(ast.operand);
  return inner ? `not ${inner}` : null;
}

function labelBinary(ast: CpmConditionAst & { kind: "and" | "or" }, joiner: "and" | "or"): string | null {
  const left = labelAst(ast.left);
  const right = labelAst(ast.right);
  return left && right ? `${left} ${joiner} ${right}` : null;
}

function labelCompare(ast: CpmConditionAst & { kind: "compare" }): string | null {
  if (ast.value.startsWith("$(")) return null;
  return ast.operator === "==" ? ast.value : `not ${ast.value}`;
}

function fallbackLabel(raw: string): string {
  return raw.replace(/[$()'"]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

/**
 * Parses the major version out of a TFM, e.g. `net10.0-windows` → 10.
 * Returns `null` for TFMs without a numeric major (e.g. `netstandard2.0`).
 */
export function getTfmMajorVersion(tfm: string): number | null {
  const match = /^net(\d+)\.\d+/i.exec(tfm.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}
