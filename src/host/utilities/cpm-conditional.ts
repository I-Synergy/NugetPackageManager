/**
 * Writes `PackageVersion` entries inside a conditional `ItemGroup`.
 *
 * Central Package Management allows one version per package per condition, so a
 * solution that mixes `net10.0` and `net11.0` needs
 * `<ItemGroup Condition="'$(TargetFramework)' == 'net11.0'">` groups; an
 * unconditional entry cannot express both requirements. The writer keeps the
 * existing file intact and appends groups only when they do not exist yet.
 */

export interface ConditionalVersionChange {
    PackageId: string;
    Version: string;
    /** MSBuild condition, e.g. `'$(TargetFramework)' == 'net11.0'`. */
    Condition: string;
}

export interface ConditionalWriteResult {
    Content: string;
    Changed: boolean;
    /** Conditions for which a new group had to be created. */
    CreatedGroups: string[];
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function normalizeCondition(value: string): string {
    return value.replace(/\s+/g, " ").replace(/'/g, '"').trim().toLowerCase();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Range of the `ItemGroup` whose `Condition` matches `condition`, if any. */
function findConditionalGroup(
    content: string,
    condition: string
): { start: number; end: number } | null {
    const groupPattern = /<ItemGroup\b([^>]*)>([\s\S]*?)<\/ItemGroup>/gi;
    let match: RegExpExecArray | null;
    while ((match = groupPattern.exec(content)) !== null) {
        const attributes = match[1] ?? "";
        const conditionMatch = /Condition\s*=\s*"([^"]*)"/i.exec(attributes);
        if (!conditionMatch?.[1]) continue;
        if (normalizeCondition(conditionMatch[1]) !== normalizeCondition(condition)) continue;
        return { start: match.index, end: match.index + match[0].length };
    }
    return null;
}

function packageVersionPattern(packageId: string): RegExp {
    const escaped = escapeRegExp(packageId);
    return new RegExp(
        String.raw`(<PackageVersion\b[^>]*\bInclude\s*=\s*("${escaped}"|'${escaped}')[^>]*\bVersion\s*=\s*")[^"]*(")`,
        "i"
    );
}

function containsPackage(slice: string, packageId: string): boolean {
    const escaped = escapeRegExp(packageId);
    return new RegExp(String.raw`<PackageVersion\b[^>]*\bInclude\s*=\s*("${escaped}"|'${escaped}')`, "i").test(
        slice
    );
}

/**
 * Applies conditional version changes. Existing entries are rewritten in place;
 * missing entries are inserted into their group, and missing groups are appended
 * before `</Project>`.
 */
export interface ConditionalWriteOptions {
    /**
     * Packages whose unconditional entry must go, because their versions now
     * differ per TFM. Keeping both entries leaves NuGet with a duplicate
     * `PackageVersion` and it silently picks the unconditional one.
     */
    ReplaceUnconditional?: string[];
}

/**
 * Removes a package's entries from the unconditional `ItemGroup`, if any.
 *
 * A conditional entry next to an unconditional one leaves NuGet with two
 * `PackageVersion` items for the same package, and it silently uses the
 * unconditional one — so the unconditional entry has to go.
 */
function removeUnconditionalEntries(
    content: string,
    packageId: string
): { content: string; removed: boolean } {
    const groupPattern = /<ItemGroup\b([^>]*)>([\s\S]*?)<\/ItemGroup>/gi;
    let match: RegExpExecArray | null;
    while ((match = groupPattern.exec(content)) !== null) {
        if (/Condition\s*=/i.test(match[1] ?? "")) continue;

        const slice = match[2] ?? "";
        const escaped = escapeRegExp(packageId);
        const element = new RegExp(
            String.raw`[ \t]*<PackageVersion\b[^>]*\bInclude\s*=\s*("${escaped}"|'${escaped}')[^>]*(?:\/>|>\s*<\/PackageVersion>)[ \t]*(?:\r?\n)?`,
            "gi"
        );
        if (!element.test(slice)) return { content, removed: false };

        const nextSlice = slice.replace(element, "");
        return {
            content:
                content.slice(0, match.index) +
                match[0].replace(slice, nextSlice) +
                content.slice(match.index + match[0].length),
            removed: true,
        };
    }
    return { content, removed: false };
}

export function ApplyConditionalPackageVersions(
    content: string,
    changes: ConditionalVersionChange[],
    options: ConditionalWriteOptions = {}
): ConditionalWriteResult {
    const replaced = ReplaceUnconditionalEntries(content, options.ReplaceUnconditional ?? []);
    let updated = replaced.Content;
    let changed = replaced.Changed;
    const createdGroups: string[] = [];

    for (const [condition, groupChanges] of GroupChangesByCondition(changes)) {
        const group = findConditionalGroup(updated, condition);
        if (group) {
            const slice = updated.slice(group.start, group.end);
            const nextSlice = ApplyToExistingGroup(slice, groupChanges);
            if (nextSlice !== slice) {
                updated = updated.slice(0, group.start) + nextSlice + updated.slice(group.end);
                changed = true;
            }
            continue;
        }
        const appended = AppendGroup(updated, condition, groupChanges);
        if (appended === null) continue;
        updated = appended;
        createdGroups.push(condition);
        changed = true;
    }

    return { Content: updated, Changed: changed, CreatedGroups: createdGroups };
}

function ReplaceUnconditionalEntries(
    content: string,
    packageIds: string[]
): { Content: string; Changed: boolean } {
    let updated = content;
    let changed = false;
    for (const packageId of packageIds) {
        const removed = removeUnconditionalEntries(updated, packageId);
        if (!removed.removed) continue;
        updated = removed.content;
        changed = true;
    }
    return { Content: updated, Changed: changed };
}

/** One entry per condition, so a single group is created per condition. */
function GroupChangesByCondition(
    changes: ConditionalVersionChange[]
): Map<string, ConditionalVersionChange[]> {
    const byCondition = new Map<string, ConditionalVersionChange[]>();
    for (const change of changes) {
        const list = byCondition.get(change.Condition) ?? [];
        list.push(change);
        byCondition.set(change.Condition, list);
    }
    return byCondition;
}

function ApplyToExistingGroup(slice: string, changes: ConditionalVersionChange[]): string {
    let nextSlice = slice;
    for (const change of changes) {
        nextSlice = containsPackage(nextSlice, change.PackageId)
            ? nextSlice.replace(packageVersionPattern(change.PackageId), `$1${escapeXml(change.Version)}$3`)
            : nextSlice.replace(
                /<\/ItemGroup>/i,
                `  <PackageVersion Include="${escapeXml(change.PackageId)}" Version="${escapeXml(change.Version)}" />\n  </ItemGroup>`
            );
    }
    return nextSlice;
}

function AppendGroup(
    content: string,
    condition: string,
    changes: ConditionalVersionChange[]
): string | null {
    const closing = content.lastIndexOf("</Project>");
    if (closing < 0) return null;
    const entries = changes.map(FormatPackageVersionEntry).join("\n");
    const block = `  <ItemGroup Condition="${escapeXml(condition)}">\n${entries}\n  </ItemGroup>\n`;
    return content.slice(0, closing) + block + content.slice(closing);
}

function FormatPackageVersionEntry(change: ConditionalVersionChange): string {
    return `    <PackageVersion Include="${escapeXml(change.PackageId)}" Version="${escapeXml(change.Version)}" />`;
}
