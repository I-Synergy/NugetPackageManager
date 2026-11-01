import fs from "node:fs";
import * as path from "node:path";

/** Returns true when `candidate` is inside `root` (or is the root itself). */
export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (relative === "") return true;
  if (relative === "..") return false;

  const normalizedRelative = process.platform === "win32" ? relative.toLowerCase() : relative;
  return !normalizedRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveRealPathAsync(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Resolves symlinks/junctions where possible and checks the candidate against every
 * workspace root. Non-existent paths fall back to their resolved absolute form.
 */
export async function isPathInWorkspaceAsync(
  candidate: string,
  workspaceRoots: string[]
): Promise<boolean> {
  if (workspaceRoots.length === 0) return false;

  const realCandidate = await resolveRealPathAsync(candidate);
  for (const root of workspaceRoots) {
    const realRoot = await resolveRealPathAsync(root);
    if (isPathInside(realRoot, realCandidate)) return true;
  }
  return false;
}

export async function findPathOutsideWorkspaceAsync(
  candidates: string[],
  workspaceRoots: string[]
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!(await isPathInWorkspaceAsync(candidate, workspaceRoots))) {
      return candidate;
    }
  }
  return null;
}
