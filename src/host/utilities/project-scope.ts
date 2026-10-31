/**
 * Project scoping shared by the discovery paths.
 *
 * The workspace can contain `.csproj` files that are not part of the solution —
 * vendored samples, templates, or cached copies such as `.ai/tmp/...`. When a
 * solution file exists, only the projects it references are managed by the
 * extension; everything else must stay out of analysis and out of any restore
 * the extension triggers.
 */

import * as path from "node:path";

/** Keeps only the projects referenced by a solution, when one was found. */
export function ScopeProjectFiles<T extends { fsPath: string }>(
    files: T[],
    solutionProjectPaths: Set<string> | null
): T[] {
    if (!solutionProjectPaths) return files;
    return files.filter((file) => solutionProjectPaths.has(path.normalize(file.fsPath)));
}

/** True when `projectPath` is one of the scoped projects. */
export function IsScopedProject(
    projectPath: string,
    solutionProjectPaths: Set<string> | null
): boolean {
    if (!solutionProjectPaths) return true;
    return solutionProjectPaths.has(path.normalize(projectPath));
}
