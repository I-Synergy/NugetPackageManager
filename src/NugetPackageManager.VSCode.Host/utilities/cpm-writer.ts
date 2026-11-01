import coreProcess from "@/host/nuget/core-process";

/**
 * Writes to `Directory.Packages.props` through the .NET core.
 *
 * This is the only code that mutates a user's files, so it lives in one place: the core
 * validates, verifies and swaps the file atomically, and the host only decides *what* to write.
 */

export type CpmWriteScope = "group" | "unconditional" | "all" | "first";

export type CpmVersionChange = {
  packageId: string;
  version: string;
  condition?: string;
  scope?: CpmWriteScope;
};

export default class CpmWriter {
  /**
   * Applies the changes and returns every file that was written. Property-definition files
   * (e.g. `Directory.Build.props`) are edited in place of the props file when a version is a
   * whole-value property reference; `projectPaths` and `workspaceRoots` are what let the core
   * locate and safely edit those files.
   */
  public static async UpdateCpmVersionsAsync(
    propsFilePath: string,
    changes: Array<CpmVersionChange>,
    projectPaths: string[] = [],
    workspaceRoots: string[] = []
  ): Promise<string[]> {
    if (changes.length === 0) {
      return [];
    }

    const result = await coreProcess.CallAsync<{ applied: number; changedFiles?: string[] }>(
      "updateCpmVersions",
      {
        propsFilePath,
        changes: changes.map((change) => ({
          packageId: change.packageId,
          version: change.version,
          ...(change.condition !== undefined && { condition: change.condition }),
          ...(change.scope !== undefined && { scope: change.scope }),
        })),
        projectPaths,
        workspaceRoots,
      }
    );

    return result.changedFiles ?? [];
  }

  /**
   * The files the writer would modify for these changes, resolved read-only so the host can
   * snapshot them before the first write. The props file is included when a literal edit would
   * touch it; property-definition files are included when their value would change.
   */
  public static async ResolveWriteTargetsAsync(
    propsFilePath: string,
    changes: Array<CpmVersionChange>,
    projectPaths: string[],
    workspaceRoots: string[]
  ): Promise<string[]> {
    if (changes.length === 0) {
      return [];
    }

    const result = await coreProcess.CallAsync<{ files?: string[] }>("resolveCpmWriteTargets", {
      propsFilePath,
      changes: changes.map((change) => ({
        packageId: change.packageId,
        version: change.version,
        ...(change.condition !== undefined && { condition: change.condition }),
        ...(change.scope !== undefined && { scope: change.scope }),
      })),
      projectPaths,
      workspaceRoots,
    });

    return result.files ?? [];
  }

  /** Removes every entry for the package; false when the props file had none. */
  public static async RemovePackageVersionAsync(
    propsFilePath: string,
    packageId: string
  ): Promise<boolean> {
    const result = await coreProcess.CallAsync<{ removed: boolean }>("removePackageVersion", {
      propsFilePath,
      packageId,
    });

    return result.removed;
  }

  public static async UpdatePackageVersionAsync(
    projectPath: string,
    packageId: string,
    version: string,
    condition?: string,
    scope?: CpmWriteScope,
    workspaceRoots: string[] = []
  ): Promise<void> {
    await coreProcess.CallAsync<{ updated: boolean }>("updatePackageVersion", {
      projectPath,
      packageId,
      version,
      ...(condition !== undefined && { condition }),
      ...(scope !== undefined && { scope }),
      workspaceRoots,
    });
  }
}
