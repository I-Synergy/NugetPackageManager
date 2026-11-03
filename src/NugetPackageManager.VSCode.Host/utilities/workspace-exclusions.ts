/**
 * Which workspace paths a scan may look at.
 *
 * These two rules are the shared answer for every discovery pass: hidden/scratch directories
 * (`.git`, `.ai`, `.vs`) are always internal, and the user's `nugetpackagemanager.excludeGlobs`
 * adds whatever else they want kept out (typically `bin` and `obj`). They live in their own module
 * because both `host-api` and the local-tools adapter need them, and `host-api` imports
 * `local-tools`.
 */

import * as vscode from "vscode";

/** Keeps hidden/scratch directories out of every package and project scan. */
export function isInternalExcludedPath(fsPath: string): boolean {
  const normalized = fsPath.replace(/\\/g, "/").toLowerCase();
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.fsPath.replace(/\\/g, "/").toLowerCase().replace(/\/$/, ""))
    .filter(Boolean);
  const root = workspaceRoots.find(
    (candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`)
  );
  const relative = root ? normalized.slice(root.length).replace(/^\/+/, "") : normalized;
  const segments = relative.split("/");
  // The final segment is the file; any hidden directory above it is excluded.
  return segments.slice(0, -1).some((segment) => segment.startsWith("."));
}

/** Excludes configured globs (for example bin and obj folders) from project discovery. */
export function applyExcludeGlobs<T extends { fsPath: string }>(files: T[], excludeGlobs: string[]): T[] {
  const visibleFiles = files.filter((file) => !isInternalExcludedPath(file.fsPath));
  if (excludeGlobs.length === 0) return visibleFiles;
  const patterns = excludeGlobs.map(
    (glob) =>
      new RegExp(
        `^${glob
          .replace(/\\/g, "/")
          .replace(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)
          .replace(/\*\*/g, "\0")
          .replace(/\*/g, "[^/]*")
          .replace(/\0/g, ".*")
          .replace(/\/$/, "")}$`,
        "i"
      )
  );
  return visibleFiles.filter((file) => {
    const normalized = file.fsPath.replace(/\\/g, "/");
    return !patterns.some((pattern) => pattern.test(normalized));
  });
}
