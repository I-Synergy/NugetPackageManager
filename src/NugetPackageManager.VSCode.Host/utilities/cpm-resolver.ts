import fs from "node:fs";
import * as path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import { Mutex } from "async-mutex";
import { Logger } from "@/common/logger";
import {
  evaluateCondition,
  getConditionLabel,
} from "./cpm-condition";
import { isValidNuGetVersion, isValidPackageId } from "./nuget-identifier";

export type CpmFrameworkEntry = {
  condition: string;  // raw XML Condition value, e.g. "$(TargetFramework.StartsWith('net8.0'))"
  framework: string;  // disambiguated label, e.g. "net8.0" or "not net11.0"
  versions: Map<string, string>;
  order: number;      // document order — the last matching group wins
};

export type CpmPackageMap = {
  unconditional: Map<string, string>;
  conditional: CpmFrameworkEntry[];
  hasConditionalGroups: boolean;
};

export type CpmVersionResolution = {
  PackageId: string;
  Tfm: string;              // "" for unconditional/shared versions
  Version: string;
  Condition: string;        // "" for unconditional
  ConditionLabel: string;
  Matched: boolean;         // false when no condition matched the project's TFMs
};

export type CpmVersionChange = {
  packageId: string;
  version: string;
  condition?: string;
  scope?: "group" | "unconditional" | "all" | "first";
};

type ItemGroupBlock = {
  condition: string;
  start: number;
  end: number;
  openTag: string;
  body: string;
  closeTag: string;
};

const PACKAGE_VERSION_TAG_RE = /<PackageVersion\b[^>]*?\/?>/gi;
const ITEM_GROUP_RE = /<ItemGroup\b([^>]*)>([\s\S]*?)<\/ItemGroup>/gi;
const CONDITION_ATTR_RE = /\bCondition\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

export default class CpmResolver {
  private static readonly fileMutexes = new Map<string, Mutex>();

  private static getFileMutex(filePath: string): Mutex {
    const key = path.normalize(filePath).toLowerCase();
    if (!this.fileMutexes.has(key)) {
      this.fileMutexes.set(key, new Mutex());
    }
    return this.fileMutexes.get(key)!;
  }

  static async GetPackageVersionsAsync(projectPath: string): Promise<Map<string, string> | null> {
    const cpmFilePath = await this.FindDirectoryPackagesPropsFileAsync(projectPath);
    if (!cpmFilePath) {
      return null;
    }

    Logger.debug(`CpmResolver.GetPackageVersions: Found CPM file at ${cpmFilePath}`);

    if (!await this.IsCentralPackageManagementEnabledAsync(projectPath, cpmFilePath)) {
      Logger.debug(`CpmResolver.GetPackageVersions: CPM is disabled for ${projectPath}`);
      return null;
    }

    return this.ParsePackageVersionsAsync(cpmFilePath);
  }

  static async GetFrameworkPackageMapAsync(projectPath: string): Promise<CpmPackageMap | null> {
    const cpmFilePath = await this.FindDirectoryPackagesPropsFileAsync(projectPath);
    if (!cpmFilePath) {
      return null;
    }

    Logger.debug(`CpmResolver.GetFrameworkPackageMap: Found CPM file at ${cpmFilePath}`);

    if (!await this.IsCentralPackageManagementEnabledAsync(projectPath, cpmFilePath)) {
      Logger.debug(`CpmResolver.GetFrameworkPackageMap: CPM is disabled for ${projectPath}`);
      return null;
    }

    return this.ParseFrameworkPackageMapAsync(cpmFilePath);
  }

  /**
   * Resolves the `Directory.Packages.props` path for a project if CPM is enabled,
   * or returns `null` if CPM is not applicable. Use the returned path as a cache key
   * so that multiple projects sharing the same props file can reuse a single parse.
   */
  static async FindCpmFilePathAsync(projectPath: string): Promise<string | null> {
    const cpmFilePath = await this.FindDirectoryPackagesPropsFileAsync(projectPath);
    if (!cpmFilePath) {
      return null;
    }

    if (!await this.IsCentralPackageManagementEnabledAsync(projectPath, cpmFilePath)) {
      return null;
    }

    return cpmFilePath;
  }

  /**
   * Parses a `Directory.Packages.props` file directly (without project-path look-up)
   * and returns its full framework-aware package map. Callers should cache the result
   * by `cpmFilePath` to avoid re-reading a shared file for each project.
   */
  static async ParseCpmFileAsync(cpmFilePath: string): Promise<CpmPackageMap> {
    return this.ParseFrameworkPackageMapAsync(cpmFilePath);
  }

  /**
   * Resolves every package version for every supplied target framework.
   *
   * - Conditions are evaluated per TFM; the last matching group in document order wins.
   * - When a project has no resolvable TFMs (dotnet unavailable), each conditional
   *   group is surfaced as its own pseudo-TFM so package versions are not lost.
   * - Packages whose condition matches none of the project's TFMs are returned with
   *   `Matched: false` so consumers can warn instead of showing a wrong version.
   */
  static ResolveVersions(
    cpmMap: CpmPackageMap,
    packageIds: string[],
    tfms: string[]
  ): Map<string, CpmVersionResolution[]> {
    const result = new Map<string, CpmVersionResolution[]>();
    const uniqueTfms = [...new Set(tfms.map((tfm) => tfm.trim()).filter(Boolean))];

    for (const packageId of new Set(packageIds)) {
      const resolutions: CpmVersionResolution[] = [];
      const seenKeys = new Set<string>();
      const add = (resolution: CpmVersionResolution): void => {
        // One row per version line (condition). A condition that matches several
        // TFMs of the same project still represents a single version line.
        if (seenKeys.has(resolution.Condition)) return;
        seenKeys.add(resolution.Condition);
        resolutions.push(resolution);
      };

      if (uniqueTfms.length === 0) {
        this.addUnconditionalAndConditional(packageId, cpmMap, add);
      } else {
        for (const tfm of uniqueTfms) {
          this.addForTfm(packageId, tfm, cpmMap, add);
        }
      }

      if (resolutions.length === 0 && uniqueTfms.length > 0) {
        this.addUnknownEntries(packageId, cpmMap, uniqueTfms, add);
      }

      if (resolutions.length > 0) {
        result.set(packageId, resolutions);
      }
    }

    return result;
  }

  private static addUnconditionalAndConditional(
    packageId: string,
    cpmMap: CpmPackageMap,
    add: (resolution: CpmVersionResolution) => void
  ): void {
    const unconditionalVersion = this.findCaseInsensitive(cpmMap.unconditional, packageId);
    if (unconditionalVersion !== undefined) {
      add(this.unconditionalResolution(packageId, unconditionalVersion));
    }
    for (const entry of cpmMap.conditional) {
      const version = this.findCaseInsensitive(entry.versions, packageId);
      if (version !== undefined) {
        add(this.conditionalResolution(packageId, entry.framework, version, entry, true));
      }
    }
  }

  private static addForTfm(
    packageId: string,
    tfm: string,
    cpmMap: CpmPackageMap,
    add: (resolution: CpmVersionResolution) => void
  ): void {
    const applicable = cpmMap.conditional.filter(
      (entry) => evaluateCondition(entry.condition, { TargetFramework: tfm }) === true
    );

    let winner: CpmFrameworkEntry | undefined;
    for (const entry of applicable) {
      if (this.findCaseInsensitive(entry.versions, packageId) !== undefined) {
        if (!winner || entry.order > winner.order) winner = entry;
      }
    }

    if (winner) {
      add(this.conditionalResolution(packageId, tfm, this.findCaseInsensitive(winner.versions, packageId)!, winner, true));
      return;
    }

    const unconditionalVersion = this.findCaseInsensitive(cpmMap.unconditional, packageId);
    if (unconditionalVersion !== undefined) {
      // Unconditional versions are shared across TFMs: surface one row only.
      add(this.unconditionalResolution(packageId, unconditionalVersion));
    }
  }

  private static addUnknownEntries(
    packageId: string,
    cpmMap: CpmPackageMap,
    uniqueTfms: string[],
    add: (resolution: CpmVersionResolution) => void
  ): void {
    // No condition matched. Fall back only for conditions that could not be
    // evaluated at all; a condition that evaluated to false simply means the
    // package belongs to a different framework line and should not be shown.
    const unknownEntries = cpmMap.conditional.filter(
      (entry) =>
        this.findCaseInsensitive(entry.versions, packageId) !== undefined &&
        uniqueTfms.some(
          (tfm) => evaluateCondition(entry.condition, { TargetFramework: tfm }) === null
        )
    );
    for (const entry of unknownEntries) {
      add(this.conditionalResolution(packageId, entry.framework, this.findCaseInsensitive(entry.versions, packageId)!, entry, false));
    }
  }

  private static unconditionalResolution(packageId: string, version: string): CpmVersionResolution {
    return {
      PackageId: packageId,
      Tfm: "",
      Version: version,
      Condition: "",
      ConditionLabel: "",
      Matched: true,
    };
  }

  private static conditionalResolution(
    packageId: string,
    tfm: string,
    version: string,
    entry: CpmFrameworkEntry,
    matched: boolean
  ): CpmVersionResolution {
    return {
      PackageId: packageId,
      Tfm: tfm,
      Version: version,
      Condition: entry.condition,
      ConditionLabel: entry.framework,
      Matched: matched,
    };
  }

  static HasPackage(cpmMap: CpmPackageMap, packageId: string): boolean {
    return (
      this.findCaseInsensitive(cpmMap.unconditional, packageId) !== undefined ||
      cpmMap.conditional.some((entry) => this.findCaseInsensitive(entry.versions, packageId) !== undefined)
    );
  }

  /**
   * Applies one or more version changes to a single `Directory.Packages.props`
   * file with a single read/write cycle. All changes are verified before writing.
   */
  static async UpdateCpmVersionsAsync(
    propsFilePath: string,
    changes: CpmVersionChange[]
  ): Promise<void> {
    if (changes.length === 0) return;

    for (const change of changes) {
      if (!isValidPackageId(change.packageId)) {
        throw new Error(`Invalid NuGet package ID: ${change.packageId}`);
      }
      if (!isValidNuGetVersion(change.version)) {
        throw new Error(`Invalid NuGet version for ${change.packageId}: ${change.version}`);
      }
    }

    const release = await this.getFileMutex(propsFilePath).acquire();
    try {
      const beforeStat = await fs.promises.stat(propsFilePath);
      const content = await fs.promises.readFile(propsFilePath, "utf8");
      let updated = content;

      for (const change of changes) {
        updated = this.applyVersionChange(updated, propsFilePath, change);
      }

      this.verifyChanges(content, updated, propsFilePath, changes);

      const afterStat = await fs.promises.stat(propsFilePath);
      if (afterStat.mtimeMs !== beforeStat.mtimeMs || afterStat.size !== beforeStat.size) {
        throw new Error(
          `${propsFilePath} changed while the update was being prepared; retry the operation`
        );
      }

      const tempPath = `${propsFilePath}.${process.pid}.tmp`;
      try {
        await fs.promises.writeFile(tempPath, updated, "utf8");
        await fs.promises.rename(tempPath, propsFilePath);
      } catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }

      Logger.info(
        `CpmResolver.UpdateCpmVersions: Applied ${changes.length} change(s) to ${propsFilePath}`
      );
    } finally {
      release();
    }
  }

  /**
   * Removes every PackageVersion entry for a package from one props file.
   * Used after the last project reference is uninstalled so CPM does not keep
   * a stale global package reference.
   */
  static async RemovePackageVersionAsync(
    propsFilePath: string,
    packageId: string
  ): Promise<boolean> {
    if (!isValidPackageId(packageId)) {
      throw new Error(`Invalid NuGet package ID: ${packageId}`);
    }

    const release = await this.getFileMutex(propsFilePath).acquire();
    try {
      const beforeStat = await fs.promises.stat(propsFilePath);
      const content = await fs.promises.readFile(propsFilePath, "utf8");
      const escaped = packageId.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
      const elementPattern = new RegExp(
        String.raw`[ \t]*<PackageVersion\b[^>]*\bInclude\s*=\s*("${escaped}"|'${escaped}')[^>]*(?:\/>|>\s*<\/PackageVersion>)[ \t]*(?:\r?\n)?`,
        "gi"
      );

      let removed = 0;
      const updated = content.replace(elementPattern, () => {
        removed++;
        return "";
      });

      if (removed === 0) return false;

      const remainingPattern = new RegExp(
        String.raw`<PackageVersion\b[^>]*\bInclude\s*=\s*("${escaped}"|'${escaped}')`,
        "i"
      );
      if (remainingPattern.test(updated)) {
        throw new Error(`Failed to remove all PackageVersion entries for ${packageId} from ${propsFilePath}`);
      }

      const afterStat = await fs.promises.stat(propsFilePath);
      if (afterStat.mtimeMs !== beforeStat.mtimeMs || afterStat.size !== beforeStat.size) {
        throw new Error(`${propsFilePath} changed while the removal was being prepared; retry the operation`);
      }

      const tempPath = `${propsFilePath}.${process.pid}.tmp`;
      try {
        await fs.promises.writeFile(tempPath, updated, "utf8");
        await fs.promises.rename(tempPath, propsFilePath);
      } catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }

      Logger.info(`CpmResolver.RemovePackageVersion: Removed ${packageId} from ${propsFilePath}`);
      return true;
    } finally {
      release();
    }
  }

  static async UpdatePackageVersionAsync(
    projectPath: string,
    packageId: string,
    newVersion: string,
    condition?: string,
    scope: "group" | "unconditional" | "all" | "first" = condition === undefined ? "first" : "group"
  ): Promise<void> {
    const cpmFilePath = await this.FindDirectoryPackagesPropsFileAsync(projectPath);
    if (!cpmFilePath) {
      throw new Error(`Directory.Packages.props not found for ${projectPath}`);
    }

    const change: CpmVersionChange = { packageId, version: newVersion, scope };
    if (condition !== undefined) {
      change.condition = condition;
    }
    await this.UpdateCpmVersionsAsync(cpmFilePath, [change]);
  }

  private static applyVersionChange(
    content: string,
    propsFilePath: string,
    change: CpmVersionChange
  ): string {
    const scope = change.scope ?? (change.condition !== undefined ? "group" : "first");

    if (scope === "group") {
      if (change.condition === undefined) {
        throw new Error(`A condition is required for scoped CPM updates in ${propsFilePath}`);
      }
      const updated = this.replaceConditionalElement(
        content,
        change.packageId,
        change.version,
        change.condition
      );
      if (!updated.changed) {
        throw new Error(
          `Package ${change.packageId} not found in ItemGroup with Condition="${change.condition}" in ${propsFilePath}`
        );
      }
      return updated.text;
    }

    if (scope === "unconditional") {
      const updated = this.replaceUnconditionalElements(content, change.packageId, change.version);
      if (!updated.changed) {
        throw new Error(`Package ${change.packageId} not found in an unconditional ItemGroup in ${propsFilePath}`);
      }
      return updated.text;
    }

    const { text: updated, changed } = this.replaceInElements(
      content,
      change.packageId,
      change.version,
      scope === "all"
    );
    if (!changed) {
      throw new Error(`Package ${change.packageId} not found in ${propsFilePath}`);
    }
    return updated;
  }

  private static replaceConditionalElement(
    content: string,
    packageId: string,
    newVersion: string,
    condition: string
  ): { text: string; changed: boolean } {
    for (const block of this.findItemGroupBlocks(content)) {
      const result = this.replaceInBody(
        block.body,
        packageId,
        newVersion,
        (tag) => {
          const elementCondition = this.getAttribute(tag, "Condition")?.trim() ?? "";
          return this.combineConditions(block.condition, elementCondition) === condition;
        },
        false
      );
      if (!result.changed) continue;

      return {
        text: content.slice(0, block.start) + block.openTag + result.text + block.closeTag + content.slice(block.end),
        changed: true,
      };
    }
    return { text: content, changed: false };
  }

  private static replaceUnconditionalElements(
    content: string,
    packageId: string,
    newVersion: string
  ): { text: string; changed: boolean } {
    let updated = content;
    let changedAny = false;

    const blocks = this.findItemGroupBlocks(content).filter((block) => block.condition === "");
    for (const block of [...blocks].reverse()) {
      const result = this.replaceInBody(
        block.body,
        packageId,
        newVersion,
        (tag) => !this.getAttribute(tag, "Condition"),
        true
      );
      if (!result.changed) continue;

      changedAny = true;
      updated = updated.slice(0, block.start) + block.openTag + result.text + block.closeTag + updated.slice(block.end);
    }

    return { text: updated, changed: changedAny };
  }

  private static replaceInBody(
    body: string,
    packageId: string,
    newVersion: string,
    predicate: (tag: string) => boolean,
    global: boolean
  ): { text: string; changed: boolean } {
    let changed = false;
    let output = "";
    let lastIndex = 0;
    PACKAGE_VERSION_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PACKAGE_VERSION_TAG_RE.exec(body)) !== null) {
      const tag = match[0];
      const include = this.getAttribute(tag, "Include");
      if (include?.toLowerCase() !== packageId.toLowerCase() || !predicate(tag)) {
        continue;
      }

      const versionPattern = /(\bVersion\s*=\s*)("[^"]*"|'[^']*')/i;
      if (!versionPattern.test(tag)) continue;

      const updatedTag = tag.replace(versionPattern, (_match, prefix: string, quoted: string) => {
        const quote = quoted.startsWith("'") ? "'" : '"';
        return `${prefix}${quote}${newVersion}${quote}`;
      });

      output += body.slice(lastIndex, match.index) + updatedTag;
      lastIndex = match.index + tag.length;
      changed = true;

      if (!global) break;
    }

    if (!changed) return { text: body, changed: false };
    output += body.slice(lastIndex);
    return { text: output, changed: true };
  }

  /**
   * Replaces the version of matching PackageVersion elements. When `global` is
   * false only the first occurrence is rewritten; when true every occurrence is.
   */
  private static replaceInElements(
    content: string,
    packageId: string,
    newVersion: string,
    global: boolean
  ): { text: string; changed: boolean } {
    let changed = false;
    const result = content.replace(PACKAGE_VERSION_TAG_RE, (tag) => {
      if (changed && !global) return tag;

      const include = this.getAttribute(tag, "Include");
      if (include?.toLowerCase() !== packageId.toLowerCase()) {
        return tag;
      }

      const versionPattern = /(\bVersion\s*=\s*)("[^"]*"|'[^']*')/i;
      if (!versionPattern.test(tag)) {
        return tag;
      }

      changed = true;
      return tag.replace(versionPattern, (_match, prefix: string, quoted: string) => {
        const quote = quoted.startsWith("'") ? "'" : '"';
        return `${prefix}${quote}${newVersion}${quote}`;
      });
    });

    return { text: result, changed };
  }

  private static verifyChanges(
    originalContent: string,
    updatedContent: string,
    propsFilePath: string,
    changes: CpmVersionChange[]
  ): void {
    const byPackage = new Map<string, CpmVersionChange[]>();
    for (const change of changes) {
      const key = change.packageId.toLowerCase();
      const list = byPackage.get(key) ?? [];
      list.push(change);
      byPackage.set(key, list);
    }

    for (const packageChanges of byPackage.values()) {
      this.verifyPackageChanges(originalContent, updatedContent, propsFilePath, packageChanges);
    }
  }

  private static verifyPackageChanges(
    originalContent: string,
    updatedContent: string,
    propsFilePath: string,
    packageChanges: CpmVersionChange[]
  ): void {
    const packageId = packageChanges[0]!.packageId;
    const before = this.collectOccurrences(originalContent, packageId);
    const after = this.collectOccurrences(updatedContent, packageId);
    this.assertOccurrenceCounts(before, after, packageId, propsFilePath);

    const expected = before.map((entry) => entry.version);
    for (const change of packageChanges) {
      this.applyExpectedChange(expected, before, change, packageId, propsFilePath);
    }
    this.assertExpectedVersions(after, expected, packageId, propsFilePath);
  }

  private static assertOccurrenceCounts(
    before: Array<{ condition: string; version: string }>,
    after: Array<{ condition: string; version: string }>,
    packageId: string,
    propsFilePath: string
  ): void {
    if (before.length === 0) {
      throw new Error(`Verification failed: ${packageId} missing from ${propsFilePath}`);
    }
    if (before.length !== after.length) {
      throw new Error(
        `Verification failed: element count for ${packageId} changed in ${propsFilePath}`
      );
    }
  }

  private static applyExpectedChange(
    expected: string[],
    before: Array<{ condition: string; version: string }>,
    change: CpmVersionChange,
    packageId: string,
    propsFilePath: string
  ): void {
    const scope = change.scope ?? (change.condition !== undefined ? "group" : "first");
    if (scope === "group") {
      this.applyGroupChange(expected, before, change, packageId, propsFilePath);
    } else if (scope === "unconditional") {
      this.applyUnconditionalChange(expected, before, change, packageId, propsFilePath);
    } else if (scope === "all") {
      for (let index = 0; index < expected.length; index++) expected[index] = change.version;
    } else {
      // "first": replaceInElements changes exactly the first matching element.
      expected[0] = change.version;
    }
  }

  private static applyGroupChange(
    expected: string[],
    before: Array<{ condition: string; version: string }>,
    change: CpmVersionChange,
    packageId: string,
    propsFilePath: string
  ): void {
    if (change.condition === undefined) {
      throw new Error(
        `Verification failed for ${packageId}: a condition is required for a group-scoped update in ${propsFilePath}`
      );
    }
    const index = before.findIndex((entry) => entry.condition === change.condition);
    if (index < 0) {
      throw new Error(
        `Verification failed for ${packageId}: Condition="${change.condition}" produced no occurrences in ${propsFilePath}`
      );
    }
    expected[index] = change.version;
  }

  private static applyUnconditionalChange(
    expected: string[],
    before: Array<{ condition: string; version: string }>,
    change: CpmVersionChange,
    packageId: string,
    propsFilePath: string
  ): void {
    const indices = before
      .map((entry, index) => (entry.condition === "" ? index : -1))
      .filter((index) => index >= 0);
    if (indices.length === 0) {
      throw new Error(
        `Verification failed for ${packageId}: no unconditional occurrence in ${propsFilePath}`
      );
    }
    for (const index of indices) expected[index] = change.version;
  }

  private static assertExpectedVersions(
    after: Array<{ condition: string; version: string }>,
    expected: string[],
    packageId: string,
    propsFilePath: string
  ): void {
    for (let index = 0; index < after.length; index++) {
      if (after[index]!.version !== expected[index]) {
        throw new Error(
          `Verification failed for ${packageId}: occurrence ${index} expected ${expected[index]}, got ${after[index]!.version} in ${propsFilePath}`
        );
      }
    }
  }

  private static collectOccurrences(
    cpmContent: string,
    packageId: string
  ): Array<{ condition: string; version: string }> {
    const document = new DOMParser().parseFromString(cpmContent);
    const itemGroups = xpath.select("//ItemGroup", document) as Node[];
    const occurrences: Array<{ condition: string; version: string }> = [];

    for (const node of itemGroups || []) {
      const group = node as Element;
      const groupCondition = group.attributes?.getNamedItem("Condition")?.value?.trim() ?? "";
      const packageVersionNodes = xpath.select("PackageVersion", group) as Node[];
      for (const pvNode of packageVersionNodes) {
        const pv = pvNode as Element;
        const include = pv.attributes?.getNamedItem("Include")?.value;
        const version = pv.attributes?.getNamedItem("Version")?.value;
        const elementCondition = pv.attributes?.getNamedItem("Condition")?.value?.trim() ?? "";
        if (include && version && include.toLowerCase() === packageId.toLowerCase()) {
          occurrences.push({
            condition: this.combineConditions(groupCondition, elementCondition),
            version,
          });
        }
      }
    }

    return occurrences;
  }

  private static findItemGroupBlocks(content: string, condition?: string): ItemGroupBlock[] {
    const blocks: ItemGroupBlock[] = [];
    ITEM_GROUP_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ITEM_GROUP_RE.exec(content)) !== null) {
      const attributes = match[1] ?? "";
      const blockCondition = this.extractCondition(attributes);
      if (condition !== undefined && blockCondition !== condition) continue;

      blocks.push({
        condition: blockCondition,
        start: match.index,
        end: match.index + match[0].length,
        openTag: `<ItemGroup${attributes}>`,
        body: match[2] ?? "",
        closeTag: "</ItemGroup>",
      });
    }
    return blocks;
  }

  private static findItemGroupBlock(content: string, condition: string): ItemGroupBlock | null {
    return this.findItemGroupBlocks(content, condition)[0] ?? null;
  }

  private static extractCondition(attributes: string): string {
    const match = CONDITION_ATTR_RE.exec(attributes);
    return (match?.[1] ?? match?.[2] ?? "").trim();
  }

  private static getAttribute(tag: string, name: string): string | undefined {
    const pattern = new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`, "i");
    const match = pattern.exec(tag);
    return match?.[1] ?? match?.[2];
  }

  private static findCaseInsensitive(map: Map<string, string>, key: string): string | undefined {
    if (map.has(key)) return map.get(key);
    const lower = key.toLowerCase();
    for (const [existingKey, value] of map) {
      if (existingKey.toLowerCase() === lower) return value;
    }
    return undefined;
  }

  private static async FindDirectoryPackagesPropsFileAsync(projectPath: string): Promise<string | null> {
    let currentDir = path.dirname(projectPath);
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      const cpmPath = path.join(currentDir, "Directory.Packages.props");
      try {
        await fs.promises.access(cpmPath);
        return cpmPath;
      } catch {
        // file doesn't exist at this level, walk up
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return null;
  }

  private static async IsCentralPackageManagementEnabledAsync(projectPath: string, cpmFilePath: string): Promise<boolean> {
    try {
      // Check if Directory.Packages.props has CPM enabled
      const cpmContent = await fs.promises.readFile(cpmFilePath, "utf8");
      const cpmDoc = new DOMParser().parseFromString(cpmContent);
      const cpmEnabled = xpath.select("string(//PropertyGroup/ManagePackageVersionsCentrally)", cpmDoc);

      if (cpmEnabled !== "true") {
        return false;
      }

      // Check if project has CPM disabled
      const projectContent = await fs.promises.readFile(projectPath, "utf8");
      const projectDoc = new DOMParser().parseFromString(projectContent);
      const projectCpmSetting = xpath.select("string(//PropertyGroup/ManagePackageVersionsCentrally)", projectDoc);

      if (projectCpmSetting === "false") {
        return false;
      }

      return true;
    } catch (error) {
      Logger.error(`CpmResolver.IsCentralPackageManagementEnabled: Failed to check CPM status for ${projectPath}`, error);
      return false;
    }
  }

  private static async ParsePackageVersionsAsync(cpmFilePath: string): Promise<Map<string, string>> {
    Logger.debug(`CpmResolver.ParsePackageVersions: Parsing ${cpmFilePath}`);
    const versionMap = new Map<string, string>();

    try {
      const cpmContent = await fs.promises.readFile(cpmFilePath, "utf8");
      const document = new DOMParser().parseFromString(cpmContent);
      const packageVersions = xpath.select("//ItemGroup/PackageVersion", document) as Node[];

      (packageVersions || []).forEach((p) => {
        const el = p as Element;
        const packageId = el.attributes?.getNamedItem("Include")?.value;
        const version = el.attributes?.getNamedItem("Version")?.value;

        if (packageId && version) {
          versionMap.set(packageId, version);
        }
      });

      Logger.debug(`CpmResolver.ParsePackageVersions: Found ${versionMap.size} package versions in ${cpmFilePath}`);
    } catch (error) {
      Logger.error(`CpmResolver.ParsePackageVersions: Failed to parse CPM versions from ${cpmFilePath}`, error);
    }

    return versionMap;
  }

  private static async ParseFrameworkPackageMapAsync(cpmFilePath: string): Promise<CpmPackageMap> {
    Logger.debug(`CpmResolver.ParseFrameworkPackageMap: Parsing ${cpmFilePath}`);
    try {
      const cpmContent = await fs.promises.readFile(cpmFilePath, "utf8");
      const map = this.parsePackageMapFromContent(cpmContent);
      Logger.debug(
        `CpmResolver.ParseFrameworkPackageMap: Found ${map.unconditional.size} unconditional, ` +
        `${map.conditional.length} conditional group(s) in ${cpmFilePath}`
      );
      return map;
    } catch (error) {
      Logger.error(`CpmResolver.ParseFrameworkPackageMap: Failed to parse ${cpmFilePath}`, error);
      return { unconditional: new Map(), conditional: [], hasConditionalGroups: false };
    }
  }

  static parsePackageMapFromContent(cpmContent: string): CpmPackageMap {
    const result: CpmPackageMap = {
      unconditional: new Map(),
      conditional: [],
      hasConditionalGroups: false,
    };

    const document = new DOMParser().parseFromString(cpmContent);
    const itemGroups = xpath.select("//ItemGroup", document) as Node[];
    let order = 0;

    (itemGroups || []).forEach((node) => {
      const el = node as Element;
      const groupCondition = el.attributes?.getNamedItem("Condition")?.value?.trim() ?? "";
      const packageVersionNodes = xpath.select("PackageVersion", el) as Node[];
      if (!packageVersionNodes?.length) return;

      for (const pvNode of packageVersionNodes) {
        order++;
        const pv = pvNode as Element;
        const packageId = pv.attributes?.getNamedItem("Include")?.value;
        const version = pv.attributes?.getNamedItem("Version")?.value;
        const elementCondition = pv.attributes?.getNamedItem("Condition")?.value?.trim() ?? "";
        if (!packageId || !version) continue;

        const condition = this.combineConditions(groupCondition, elementCondition);
        if (!condition) {
          result.unconditional.set(packageId, version);
          continue;
        }

        result.hasConditionalGroups = true;
        let entry = result.conditional.find((item) => item.condition === condition);
        if (!entry) {
          entry = {
            condition,
            framework: getConditionLabel(condition),
            versions: new Map(),
            order,
          };
          result.conditional.push(entry);
        } else {
          // The same condition may appear in several ItemGroups: document order
          // must reflect the last occurrence for last-match-wins resolution.
          entry.order = order;
        }
        entry.versions.set(packageId, version);
      }
    });

    return result;
  }

  private static combineConditions(groupCondition: string, elementCondition: string): string {
    if (!groupCondition) return elementCondition;
    if (!elementCondition) return groupCondition;
    return `(${groupCondition}) And (${elementCondition})`;
  }
}
