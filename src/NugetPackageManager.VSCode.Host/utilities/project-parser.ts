import fs from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import * as path from "node:path";
import { Logger } from "@/common/logger";

export default class ProjectParser {
  static async ParseAsync(projectPath: string, cpmVersions?: Map<string, string> | null): Promise<Project> {
    Logger.debug(`ProjectParser.Parse: Parsing project: ${projectPath}`);
    const projectContent = await fs.promises.readFile(projectPath, "utf8");
    const document = new DOMParser().parseFromString(projectContent);

    // Check for parsing errors or empty document
    if (!document?.documentElement) {
      Logger.error(`ProjectParser.Parse: ${projectPath} has invalid content`);
      throw new Error(`${projectPath} has invalid content`);
    }

    // Handle XML Namespaces
    const select = xpath.useNamespaces({ "ns": "http://schemas.microsoft.com/developer/msbuild/2003" });
    let packagesReferences: Node[] = [];

    // Try selecting with namespace first
    try {
        if (document.documentElement.getAttribute("xmlns") === "http://schemas.microsoft.com/developer/msbuild/2003") {
             packagesReferences = select("//ns:ItemGroup/ns:PackageReference", document) as Node[];
        } else {
             // Fallback to no namespace if not present
             packagesReferences = xpath.select("//ItemGroup/PackageReference", document) as Node[];
        }
    } catch (_e) {
        // Fallback to local-name strategy if namespace selection fails or is complicated
        packagesReferences = xpath.select("//*[local-name()='ItemGroup']/*[local-name()='PackageReference']", document) as Node[];
    }

    // If we still found nothing, try the local-name strategy as a final fallback
    if (!packagesReferences || packagesReferences.length === 0) {
         packagesReferences = xpath.select("//*[local-name()='ItemGroup']/*[local-name()='PackageReference']", document) as Node[];
    }

    const project: Project = {
      Path: projectPath,
      Name: path.basename(projectPath),
      Packages: [],
      CpmEnabled: false,
    };

    (packagesReferences || []).forEach((p) => {
      const el = p as Element;
      const packageId = el.attributes?.getNamedItem("Include")?.value ?? "";
      let version = readPackageVersion(el, p);
      const versionOverride = readVersionOverride(el, p);

      let versionSource: VersionSource = "project";
      if (cpmVersions) {
        const cpmResolution = resolveCpmVersion(packageId, version, versionOverride, cpmVersions, projectPath);
        version = cpmResolution.version;
        versionSource = cpmResolution.versionSource;
      }

      project.Packages.push({
        Id: packageId,
        Version: version || "",
        IsPinned: isPinnedVersion(version),
        VersionSource: versionSource,
      });
    });

    return project;
  }
}

function readPackageVersion(el: Element, node: Node): string | undefined {
  const attribute = el.attributes?.getNamedItem("Version")?.value;
  if (attribute) return attribute;
  const child = xpath.select("string(Version)", node);
  if (child) return child.toString();
  const namespacedChild = xpath.select("string(*[local-name()='Version'])", node);
  return namespacedChild ? namespacedChild.toString() : undefined;
}

function readVersionOverride(el: Element, node: Node): string | undefined {
  const attribute = el.attributes?.getNamedItem("VersionOverride")?.value;
  if (attribute) return attribute;
  const child = xpath.select("string(*[local-name()='VersionOverride'])", node);
  return child ? child.toString() || undefined : undefined;
}

function resolveCpmVersion(
  packageId: string,
  version: string | undefined,
  versionOverride: string | undefined,
  cpmVersions: Map<string, string>,
  projectPath: string
): { version: string | undefined; versionSource: VersionSource } {
  if (versionOverride) {
    Logger.debug(`ProjectParser.Parse: Package ${packageId} uses VersionOverride ${versionOverride} in ${projectPath}`);
    return { version: versionOverride, versionSource: "override" };
  }
  const cpmVersion = cpmVersions.get(packageId) || null;
  if (cpmVersion) return { version: cpmVersion, versionSource: "central" };
  Logger.warn(`ProjectParser.Parse: CPM version not found for package ${packageId} in ${projectPath}`);
  return { version, versionSource: "project" };
}

function isPinnedVersion(version: string | undefined): boolean {
  // NuGet: [1.0] means x == 1.0 (exact, pinned); ranges with a comma are not pinned.
  return !!version && version.startsWith('[') && version.endsWith(']') && !version.includes(',');
}
