import fs from "node:fs";
import * as path from "node:path";
import coreProcess from "@/host/nuget/core-process";

/**
 * Reads `Directory.Packages.props` through the .NET core.
 *
 * The core owns parsing (including condition evaluation and per-framework labels), so this
 * adapter only decides *which* file to read and turns the wire shape back into `Map`s. The
 * directory walk and the CPM opt-out check stay here because they are workspace concerns
 * (`vscode` globbing aside, they are plain file look-ups).
 */

export type CpmFrameworkEntry = {
  condition: string; // raw XML Condition value, e.g. "$(TargetFramework.StartsWith('net8.0'))"
  framework: string; // disambiguated label, e.g. "net8.0" or "not net11.0"
  versions: Map<string, string>;
  order: number; // document order — the last matching group wins
};

export type CpmPackageMap = {
  unconditional: Map<string, string>;
  conditional: CpmFrameworkEntry[];
  hasConditionalGroups: boolean;
};

type CpmMapWire = {
  unconditional: Record<string, string>;
  conditional: Array<{
    condition: string;
    framework: string;
    versions: Record<string, string>;
    order: number;
  }>;
  hasConditionalGroups: boolean;
};

const PROPS_FILE_NAME = "Directory.Packages.props";
const PROPERTY_RE = (name: string): RegExp =>
  new RegExp(String.raw`<${name}(?:\s[^>]*)?>\s*([^<]*?)\s*</${name}>`, "i");

export default class CpmReader {
  /** The props file that governs the project when CPM is enabled, otherwise null. */
  public static async FindCpmFilePathAsync(projectPath: string): Promise<string | null> {
    const cpmFilePath = this.findDirectoryPackagesPropsFile(projectPath);
    if (cpmFilePath === null) {
      return null;
    }

    return (await this.isEnabledAsync(projectPath, cpmFilePath)) ? cpmFilePath : null;
  }

  /** Parses one props file and returns its framework-aware package map. */
  public static async ParseCpmFileAsync(cpmFilePath: string): Promise<CpmPackageMap> {
    const wire = await coreProcess.CallAsync<CpmMapWire | null>("getCpmMap", {
      propsFilePath: cpmFilePath,
    });

    if (wire === null) {
      return { unconditional: new Map(), conditional: [], hasConditionalGroups: false };
    }

    return {
      unconditional: new Map(Object.entries(wire.unconditional)),
      conditional: wire.conditional.map((entry) => ({
        condition: entry.condition,
        framework: entry.framework,
        versions: new Map(Object.entries(entry.versions)),
        order: entry.order,
      })),
      hasConditionalGroups: wire.hasConditionalGroups,
    };
  }

  /** The framework-aware map for a project, or null when CPM does not apply to it. */
  public static async GetFrameworkPackageMapAsync(
    projectPath: string
  ): Promise<CpmPackageMap | null> {
    const cpmFilePath = await this.FindCpmFilePathAsync(projectPath);
    if (cpmFilePath === null) {
      return null;
    }

    return this.ParseCpmFileAsync(cpmFilePath);
  }

  public static HasPackage(cpmMap: CpmPackageMap, packageId: string): boolean {
    const lower = packageId.toLowerCase();
    if ([...cpmMap.unconditional.keys()].some((id) => id.toLowerCase() === lower)) {
      return true;
    }

    return cpmMap.conditional.some((entry) =>
      [...entry.versions.keys()].some((id) => id.toLowerCase() === lower)
    );
  }

  /** Every package id the map defines, in the casing the file uses. */
  public static PackageIds(cpmMap: CpmPackageMap): Set<string> {
    const ids = new Set<string>();
    for (const id of cpmMap.unconditional.keys()) ids.add(id);
    for (const entry of cpmMap.conditional) {
      for (const id of entry.versions.keys()) ids.add(id);
    }
    return ids;
  }

  private static findDirectoryPackagesPropsFile(projectPath: string): string | null {
    let directory = path.dirname(projectPath);
    const root = path.parse(directory).root;

    while (directory !== root) {
      const candidate = path.join(directory, PROPS_FILE_NAME);
      if (fs.existsSync(candidate)) {
        return candidate;
      }

      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }

    return null;
  }

  /**
   * Mirrors `CpmPropsReader.IsEnabled`: the props file must opt in and the project must not
   * opt out. Matching the first element with that name is enough for a project file; a
   * malformed or unreadable file disables CPM instead of failing the caller.
   */
  private static async isEnabledAsync(
    projectPath: string,
    cpmFilePath: string
  ): Promise<boolean> {
    try {
      const propsEnabled = PROPERTY_RE("ManagePackageVersionsCentrally").exec(
        await fs.promises.readFile(cpmFilePath, "utf8")
      )?.[1];
      if (propsEnabled !== "true") {
        return false;
      }

      const projectSetting = PROPERTY_RE("ManagePackageVersionsCentrally").exec(
        await fs.promises.readFile(projectPath, "utf8")
      )?.[1];
      return projectSetting !== "false";
    } catch {
      return false;
    }
  }
}
