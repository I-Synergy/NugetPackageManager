/**
 * Parser for the version-conflict diagnostics emitted by `dotnet restore`.
 *
 * The restore output is the only authoritative description of why a package
 * graph cannot be resolved. Instead of collapsing every failure into
 * "there may be version conflicts", keep the constraint chains so the UI can
 * say which package pins which version.
 *
 * Example input:
 *
 *   C:\ws\Sample.csproj : error NU1107: Version conflict detected for
 *     Microsoft.EntityFrameworkCore.Relational. Install/reference ... 11.0.0-rc.3.26522.148 ...
 *   C:\ws\Sample.csproj :  Sample.Api -> I-Synergy.Framework.EventSourcing.EntityFramework
 *     -> Microsoft.EntityFrameworkCore.Relational (>= 11.0.0-rc.3.26522.148)
 *   C:\ws\Sample.csproj :  Sample.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2
 *     -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0-rc.2.26504.105).
 */

export type RestoreConstraint = {
    /** Human-readable dependency chain, e.g. `Sample.Api -> Npgsql... -> EF.Relational (= 1.0.0)`. */
    chain: string;
    /** The NuGet range at the end of the chain, e.g. `= 11.0.0-rc.2.26504.105`. */
    range: string;
};

export type RestoreConflict = {
    code: string;
    /** The package whose version is contested. Empty when the diagnostic does not name one. */
    packageId: string;
    /** The version NuGet suggests referencing directly, when the diagnostic offers one. */
    suggestedVersion?: string;
    projectName?: string;
    message: string;
    constraints: RestoreConstraint[];
};

const ERROR_LINE_RE = /\berror\s+(NU\d{4})\s*:\s*(.*)/i;
// MSBuild prefixes each diagnostic with `<project> : `. Strip it so the same
// parser works for `dotnet restore` output with and without the prefix.
const PATH_PREFIX_RE = /^.*?\s:\s/;

function stripPathPrefix(line: string): string {
    return line.replace(PATH_PREFIX_RE, "");
}

function extractConstraint(sanitized: string): RestoreConstraint | null {
    if (!sanitized.includes(" -> ")) return null;
    const chain = sanitized.trim().replace(/\s+/g, " ").replace(/\.$/, "");
    const rangeMatch = /\(([^()]+)\)\s*\.?$/.exec(chain);
    return {
        chain,
        range: rangeMatch?.[1]?.trim() ?? "",
    };
}

function parseHead(code: string, message: string): Omit<RestoreConflict, "constraints"> {
    const conflict: Omit<RestoreConflict, "constraints"> = { code, packageId: "", message };
    if (code === "NU1107") return parseNu1107(conflict, message);
    if (code === "NU1605" || code === "NU1109") return parseDowngrade(conflict, message);
    if (code === "NU1608") return parseOutsideConstraint(conflict, message);
    if (code === "NU1102") return parseMissingPackage(conflict, message);
    return conflict;
}

function parseNu1107(
    conflict: Omit<RestoreConflict, "constraints">,
    message: string
): Omit<RestoreConflict, "constraints"> {
    const conflictMatch = /Version conflict detected for (.+?)\.\s/.exec(message);
    if (conflictMatch?.[1]) conflict.packageId = conflictMatch[1].trim();
    const installMatch = /Install\/reference (.+?) (\S+) directly to project (.+?) to resolve/i.exec(message);
    if (installMatch?.[2]) conflict.suggestedVersion = installMatch[2].trim();
    if (installMatch?.[3]) conflict.projectName = installMatch[3].trim();
    return conflict;
}

function parseDowngrade(
    conflict: Omit<RestoreConflict, "constraints">,
    message: string
): Omit<RestoreConflict, "constraints"> {
    const downgradeMatch = /Detected package downgrade: (.+?) from (\S+) to (\S+)/i.exec(message);
    if (downgradeMatch?.[1]) conflict.packageId = downgradeMatch[1].trim();
    if (downgradeMatch?.[2]) conflict.suggestedVersion = downgradeMatch[2].trim();
    return conflict;
}

function parseOutsideConstraint(
    conflict: Omit<RestoreConflict, "constraints">,
    message: string
): Omit<RestoreConflict, "constraints"> {
    const outsideMatch =
        /Detected package version outside of dependency constraint: .+? \S+ requires (.+?) \(([^)]+)\)/i.exec(message);
    if (outsideMatch?.[1]) conflict.packageId = outsideMatch[1].trim();
    return conflict;
}

function parseMissingPackage(
    conflict: Omit<RestoreConflict, "constraints">,
    message: string
): Omit<RestoreConflict, "constraints"> {
    const missingMatch = /Unable to find package (.+?) with version/i.exec(message);
    if (missingMatch?.[1]) conflict.packageId = missingMatch[1].trim();
    return conflict;
}

/**
 * Parses every recognized `NUxxxx` diagnostic in a restore output. Unknown
 * error codes are ignored here; `SummarizeRestoreFailure` keeps their text.
 */
export function ParseRestoreConflicts(output: string): RestoreConflict[] {
    const conflicts: RestoreConflict[] = [];
    let current: RestoreConflict | null = null;

    for (const rawLine of output.split(/\r?\n/)) {
        const sanitized = stripPathPrefix(rawLine);
        const errorMatch = ERROR_LINE_RE.exec(sanitized);
        if (errorMatch?.[1] && errorMatch[2] !== undefined) {
            current = { ...parseHead(errorMatch[1].toUpperCase(), errorMatch[2].trim()), constraints: [] };
            conflicts.push(current);
            continue;
        }

        if (!current) continue;

        if (!sanitized.trim()) continue;

        if (sanitized.includes("->")) {
            const constraint = extractConstraint(sanitized);
            if (constraint) current.constraints.push(constraint);
            continue;
        }

        // A non-chain line ends the current diagnostic block.
        current = null;
    }

    // De-duplicate identical constraints that some SDK versions print twice.
    for (const conflict of conflicts) {
        const seen = new Set<string>();
        conflict.constraints = conflict.constraints.filter((constraint) => {
            const key = `${constraint.chain}\0${constraint.range}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    return conflicts;
}

/** Formats parsed conflicts into one actionable sentence for the UI. */
export function FormatRestoreConflicts(conflicts: RestoreConflict[]): string {
    const entries = conflicts.map((conflict) => {
        const head = conflict.packageId ? `${conflict.code} ${conflict.packageId}` : conflict.code;
        const chains = conflict.constraints.map((constraint) => constraint.chain).join("; ");
        return chains ? `${head} — ${chains}` : `${head} — ${conflict.message}`;
    });
    // The same conflict is reported once per restored project.
    return [...new Set(entries)].join(" | ");
}

/**
 * Best-effort human summary of a failed restore: parsed conflicts when the
 * diagnostic is recognized, otherwise the most relevant error lines.
 */
export function SummarizeRestoreFailure(output: string): string | null {
    const conflicts = ParseRestoreConflicts(output);
    if (conflicts.length > 0) return FormatRestoreConflicts(conflicts);

    const errorLines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /\berror\s+[A-Z]+\d+/i.test(line))
        .map((line) => line.replace(PATH_PREFIX_RE, ""));

    if (errorLines.length > 0) {
        return [...new Set(errorLines)].slice(0, 5).join(" | ");
    }

    const tail = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3);
    return tail.length > 0 ? tail.join(" | ") : null;
}
