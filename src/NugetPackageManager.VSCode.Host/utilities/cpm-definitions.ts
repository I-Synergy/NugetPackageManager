/**
 * Pure text writers for adding central `PackageVersion` definitions and for
 * inspecting/cleaning the `PackageReference` that needs one.
 *
 * Nothing here imports `vscode`: the host decides which files to touch, and
 * these helpers do the byte-level edit so the report and the add operation can
 * be unit-tested without a workspace.
 */

export type PackageVersionEntry = {
    PackageId: string;
    Version: string;
};

export type AddUnconditionalResult = {
    Content: string;
    Changed: boolean;
    /** True when no unconditional `ItemGroup` existed and one had to be created. */
    CreatedGroup: boolean;
};

export type PackageReferenceInspection = {
    Found: boolean;
    HasCondition: boolean;
    Version: string | null;
    VersionOverride: string | null;
};

export type RemoveInlineReason =
    | "conditionalReference"
    | "propertyVersion"
    | "notFound"
    | "noVersionAttribute";

export type RemoveInlineResult = {
    Content: string;
    Changed: boolean;
    Reason?: RemoveInlineReason;
};

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function detectNewline(content: string): "\r\n" | "\n" {
    return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Every package id the file already declares, unconditional or conditional, lowercased. */
function collectDeclaredIds(content: string): Set<string> {
    const ids = new Set<string>();
    const pattern = /<PackageVersion\b[^>]*?\bInclude\s*=\s*("([^"]*)"|'([^']*)')/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
        const id = match[2] ?? match[3] ?? "";
        if (id) ids.add(id.toLowerCase());
    }
    return ids;
}

/** The indentation of the first element on its own line inside a slice, if any. */
function firstChildIndent(slice: string): string | null {
    const match = /(?:\r?\n)([ \t]*)</.exec(slice);
    return match ? match[1]! : null;
}

/** The indentation of the line that contains `index`, i.e. the whitespace before it. */
function lineIndent(content: string, index: number): string {
    const lineStart = content.lastIndexOf("\n", index - 1) + 1;
    return /^[ \t]*/.exec(content.slice(lineStart))![0];
}

function formatEntries(entries: PackageVersionEntry[], indent: string, nl: string): string {
    return entries
        .map((entry) => `${indent}<PackageVersion Include="${escapeXml(entry.PackageId)}" Version="${escapeXml(entry.Version)}" />`)
        .join(nl);
}

/**
 * Inserts `<PackageVersion Include Version />` entries into the first unconditional `ItemGroup`.
 *
 * Ids already declared anywhere in the file (unconditional or conditional) are skipped, so the
 * call is idempotent. When the file has no unconditional group, a new one is created right after
 * the `<Project …>` opening tag, before its children. Newline style and indentation are preserved.
 */
export function AddUnconditionalPackageVersions(
    content: string,
    entries: PackageVersionEntry[]
): AddUnconditionalResult {
    const declared = collectDeclaredIds(content);
    const toAdd = entries.filter((entry) => !declared.has(entry.PackageId.toLowerCase()));
    if (toAdd.length === 0) {
        return { Content: content, Changed: false, CreatedGroup: false };
    }

    const nl = detectNewline(content);
    const groupPattern = /<ItemGroup\b([^>]*)>[\s\S]*?<\/ItemGroup>/gi;
    let match: RegExpExecArray | null;
    while ((match = groupPattern.exec(content)) !== null) {
        const attrs = match[1] ?? "";
        if (/\bCondition\s*/i.test(attrs)) continue;

        const groupStart = match.index;
        const openTagEnd = groupStart + match[0].indexOf(">") + 1;
        const closeTagStart = groupStart + match[0].lastIndexOf("</ItemGroup>");
        const inner = content.slice(openTagEnd, closeTagStart);
        const childIndent = firstChildIndent(inner) ?? "    ";
        const entryBlock = formatEntries(toAdd, childIndent, nl);

        let updated: string;
        if (inner.includes("\n")) {
            // Insert the entries on their own lines before the indentation of the close tag.
            const lastNl = content.lastIndexOf("\n", closeTagStart - 1);
            const insertAt = lastNl + 1;
            updated = content.slice(0, insertAt) + entryBlock + nl + content.slice(insertAt);
        } else {
            const groupIndent = lineIndent(content, groupStart);
            updated =
                content.slice(0, closeTagStart) +
                nl +
                entryBlock +
                nl +
                groupIndent +
                content.slice(closeTagStart);
        }
        return { Content: updated, Changed: true, CreatedGroup: false };
    }

    return createGroupAfterProject(content, toAdd, nl);
}

function createGroupAfterProject(
    content: string,
    entries: PackageVersionEntry[],
    nl: string
): AddUnconditionalResult {
    const projectMatch = /<Project\b[^>]*>/.exec(content);
    if (!projectMatch) {
        return { Content: content, Changed: false, CreatedGroup: false };
    }

    const openTagEnd = projectMatch.index + projectMatch[0].length;
    const after = content.slice(openTagEnd);
    const groupIndent = firstChildIndent(after) ?? "  ";
    const childIndent = `${groupIndent}  `;
    const entryBlock = formatEntries(entries, childIndent, nl);
    const block =
        `${nl}${groupIndent}<ItemGroup>${nl}` +
        `${entryBlock}${nl}` +
        `${groupIndent}</ItemGroup>`;

    return {
        Content: content.slice(0, openTagEnd) + block + content.slice(openTagEnd),
        Changed: true,
        CreatedGroup: true,
    };
}

function readAttribute(attributes: string, name: string): string | null {
    const pattern = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*("([^"]*)"|'([^']*)')`, "i");
    const match = pattern.exec(attributes);
    if (!match) return null;
    return match[2] !== undefined ? match[2] : match[3]!;
}

/** The first `<PackageReference>` element whose `Include` matches, and what it declares. */
export function InspectPackageReference(content: string, packageId: string): PackageReferenceInspection {
    const wanted = packageId.toLowerCase();
    const pattern = /<PackageReference\b([^>]*?)\/?>/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
        const attributes = match[1] ?? "";
        const include = readAttribute(attributes, "Include");
        if (include?.toLowerCase() !== wanted) continue;
        return {
            Found: true,
            HasCondition: readAttribute(attributes, "Condition") !== null,
            Version: readAttribute(attributes, "Version"),
            VersionOverride: readAttribute(attributes, "VersionOverride"),
        };
    }
    return { Found: false, HasCondition: false, Version: null, VersionOverride: null };
}

/**
 * Removes a literal `Version` attribute from the matching `<PackageReference>`.
 *
 * Refuses (returning the original content untouched) when the element carries a `Condition` or
 * when the version is an MSBuild property reference (`$(…)`): either case needs a human decision.
 * `VersionOverride` is left in place, and every other byte of the file is preserved.
 */
export function RemoveInlinePackageVersion(content: string, packageId: string): RemoveInlineResult {
    const wanted = packageId.toLowerCase();
    const pattern = /<PackageReference\b([^>]*?)\/?>/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
        const attributes = match[1] ?? "";
        const include = readAttribute(attributes, "Include");
        if (include?.toLowerCase() !== wanted) continue;

        if (readAttribute(attributes, "Condition") !== null) {
            return { Content: content, Changed: false, Reason: "conditionalReference" };
        }
        const version = readAttribute(attributes, "Version");
        if (version === null) {
            return { Content: content, Changed: false, Reason: "noVersionAttribute" };
        }
        if (version.includes("$(")) {
            return { Content: content, Changed: false, Reason: "propertyVersion" };
        }

        const element = match[0];
        const attrPattern = new RegExp(String.raw`\s+Version\s*=\s*(["'])${escapeRegExp(version)}\1`, "i");
        const withoutVersion = element.replace(attrPattern, "");
        const updated = content.slice(0, match.index) + withoutVersion + content.slice(match.index + element.length);
        return { Content: updated, Changed: true };
    }

    return { Content: content, Changed: false, Reason: "notFound" };
}
