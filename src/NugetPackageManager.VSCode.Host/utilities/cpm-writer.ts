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
  public static async UpdateCpmVersionsAsync(
    propsFilePath: string,
    changes: Array<CpmVersionChange>
  ): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    await coreProcess.CallAsync<{ applied: number }>("updateCpmVersions", {
      propsFilePath,
      changes: changes.map((change) => ({
        packageId: change.packageId,
        version: change.version,
        ...(change.condition !== undefined && { condition: change.condition }),
        ...(change.scope !== undefined && { scope: change.scope }),
      })),
    });
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
    scope?: CpmWriteScope
  ): Promise<void> {
    await coreProcess.CallAsync<{ updated: boolean }>("updatePackageVersion", {
      projectPath,
      packageId,
      version,
      ...(condition !== undefined && { condition }),
      ...(scope !== undefined && { scope }),
    });
  }
}
