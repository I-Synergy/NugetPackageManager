import fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import { Logger } from "../../common/logger";
import { ResolveDotnetContext } from "./dotnet-context";

const execFileAsync = promisify(execFile);

/** Locale-fixed comparator, so cached key parts are stable across machines. */
function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, "en");
}

export type TargetFrameworkSource = "msbuild" | "xml" | "assets" | "override";

export type TargetFrameworkInfo = {
  Frameworks: string[];
  Source: TargetFrameworkSource;
  /**
   * Set when `dotnet msbuild` could not evaluate the project (broken SDK,
   * missing workload, timeout). `Source: "xml"` then means "fallback", not
   * "the project declares its frameworks literally".
   */
  EvaluationFailed?: boolean;
};

type CacheEntry = {
  key: string;
  info: TargetFrameworkInfo;
};

type MsBuildEvaluator = (projectPath: string) => Promise<string[]>;

const CONFIG_FILES = [
  "Directory.Build.props",
  "Directory.Build.targets",
  "global.json",
];

/**
 * Resolves the target frameworks a project actually builds for.
 *
 * The authoritative path runs `dotnet msbuild -getProperty`, which evaluates
 * MSBuild conditions such as
 * `$([MSBuild]::VersionGreaterThanOrEquals('$(BundledNETCoreAppPackageVersion)', '11.0'))`.
 * A literal XML parse is used when dotnet is unavailable or times out.
 */
export default class ProjectFrameworkResolver {
  private static readonly cache = new Map<string, CacheEntry>();
  private static readonly MAX_CACHE_ENTRIES = 500;
  private static readonly MAX_CONCURRENT_EVALUATIONS = 16;
  private static activeEvaluations = 0;
  private static readonly evaluationQueue: Array<() => void> = [];

  /** Injectable for tests; `null` restores the MSBuild evaluator. */
  private static evaluator: MsBuildEvaluator | null = null;

  static SetEvaluatorForTests(evaluator: MsBuildEvaluator | null): void {
    this.evaluator = evaluator;
    this.cache.clear();
  }

  static ClearCache(): void {
    this.cache.clear();
  }

  static InvalidateProject(projectPath: string): void {
    this.cache.delete(this.normalize(projectPath));
  }

  static async GetTargetFrameworksAsync(
    projectPath: string,
    overrides: string[] = []
  ): Promise<TargetFrameworkInfo> {
    if (!fs.existsSync(projectPath)) {
      return { Frameworks: this.normalizeFrameworks(overrides), Source: "override" };
    }

    const key = await this.BuildCacheKeyAsync(projectPath);
    const cached = this.cache.get(this.normalize(projectPath));
    if (cached?.key === key) {
      return this.withOverrides(cached.info, overrides);
    }

    let info: TargetFrameworkInfo;
    const fromLiteralXml = await this.TryParseUnconditionalFrameworksAsync(projectPath);
    const fromAssets = fromLiteralXml ? null : await this.TryResolveFromAssetsAsync(projectPath);
    if (fromLiteralXml) {
      info = fromLiteralXml;
    } else if (fromAssets) {
      info = fromAssets;
    } else {
      try {
        const evaluator = this.evaluator ?? ((p: string) => this.EvaluateWithMsBuildAsync(p));
        await this.acquireEvaluationSlotAsync();
        let frameworks: string[];
        try {
          frameworks = await evaluator(projectPath);
        } finally {
          this.releaseEvaluationSlot();
        }
        if (frameworks.length > 0) {
          info = { Frameworks: this.normalizeFrameworks(frameworks), Source: "msbuild" };
        } else {
          info = await this.ParseProjectFileAsync(projectPath);
        }
      } catch (error) {
        Logger.warn(
          `ProjectFrameworkResolver: MSBuild evaluation failed for ${projectPath}; falling back to XML (${String(error)})`
        );
        info = { ...(await this.ParseProjectFileAsync(projectPath)), EvaluationFailed: true };
      }
    }

    info = this.withOverrides(info, overrides);
    if (this.cache.size >= this.MAX_CACHE_ENTRIES) {
      this.cache.clear();
    }
    this.cache.set(this.normalize(projectPath), { key, info });
    return info;
  }

  static async GetTargetFrameworksBatchAsync(
    projectPaths: string[],
    overrides: string[] = [],
    concurrency = 4
  ): Promise<Map<string, TargetFrameworkInfo>> {
    const result = new Map<string, TargetFrameworkInfo>();
    let index = 0;

    const worker = async (): Promise<void> => {
      while (index < projectPaths.length) {
        const projectPath = projectPaths[index++]!;
        try {
          result.set(projectPath, await this.GetTargetFrameworksAsync(projectPath, overrides));
        } catch (error) {
          Logger.error(`ProjectFrameworkResolver: Failed to resolve TFMs for ${projectPath}`, error);
          result.set(projectPath, { Frameworks: [], Source: "xml" });
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, projectPaths.length) }, () => worker());
    await Promise.all(workers);
    return result;
  }

  /**
   * Fast path for a single, unconditional, literal `<TargetFramework(s)>`.
   * Any condition, property expression, import or multiple declarations can
   * change the effective list, so those projects fall through to assets/MSBuild.
   */
  private static async TryParseUnconditionalFrameworksAsync(
    projectPath: string
  ): Promise<TargetFrameworkInfo | null> {
    try {
      const content = await fs.promises.readFile(projectPath, "utf8");
      const document = new DOMParser().parseFromString(content);
      const nodes = xpath.select(
        "//*[local-name()='TargetFramework' or local-name()='TargetFrameworks']",
        document
      ) as Node[];

      if (nodes.length !== 1) return null;

      const element = nodes[0] as Element;
      let ancestor: Node | null = element;
      while (ancestor?.nodeType === 1) {
        if ((ancestor as Element).attributes?.getNamedItem("Condition")) return null;
        ancestor = ancestor.parentNode;
      }

      const raw = String(element.textContent ?? "").trim();
      if (!raw || /[$@%]\(/.test(raw)) return null;

      const frameworks = this.normalizeFrameworks(raw.split(";"));
      return frameworks.length > 0 ? { Frameworks: frameworks, Source: "xml" } : null;
    } catch {
      return null;
    }
  }

  /**
   * Reads the target frameworks recorded by the last restore. This avoids one
   * `dotnet msbuild` process per project on the first load. Assets are only used
   * when they are at least as new as the project file.
   */
  private static async TryResolveFromAssetsAsync(
    projectPath: string
  ): Promise<TargetFrameworkInfo | null> {
    const assetsPath = path.join(path.dirname(projectPath), "obj", "project.assets.json");
    try {
      const [assetsStat, projectStat] = await Promise.all([
        fs.promises.stat(assetsPath),
        fs.promises.stat(projectPath),
      ]);
      if (assetsStat.mtimeMs < projectStat.mtimeMs) return null;

      const parsed = JSON.parse(await fs.promises.readFile(assetsPath, "utf8")) as {
        targets?: Record<string, unknown>;
      };
      const frameworks = this.normalizeFrameworks(
        Object.keys(parsed.targets ?? {}).map((target) => target.split("/")[0] ?? target)
      );
      return frameworks.length > 0 ? { Frameworks: frameworks, Source: "assets" } : null;
    } catch {
      return null;
    }
  }

  /** Literal (non-evaluated) parse of `<TargetFramework(s)>` elements. */
  static async ParseProjectFileAsync(projectPath: string): Promise<TargetFrameworkInfo> {
    try {
      const content = await fs.promises.readFile(projectPath, "utf8");
      const document = new DOMParser().parseFromString(content);

      const multi = String(xpath.select("string(//*[local-name()='TargetFrameworks'])", document)).trim();
      if (multi && !multi.includes("$(")) {
        const frameworks = this.normalizeFrameworks(multi.split(";"));
        if (frameworks.length > 0) {
          return { Frameworks: frameworks, Source: "xml" };
        }
      }

      const single = String(xpath.select("string(//*[local-name()='TargetFramework'])", document)).trim();
      if (single && !single.includes("$(")) {
        return { Frameworks: this.normalizeFrameworks([single]), Source: "xml" };
      }
    } catch (error) {
      Logger.error(`ProjectFrameworkResolver: Failed to parse ${projectPath}`, error);
    }
    return { Frameworks: [], Source: "xml" };
  }

  private static async EvaluateWithMsBuildAsync(projectPath: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      "dotnet",
      [
        "msbuild",
        projectPath,
        "-getProperty:TargetFramework",
        "-getProperty:TargetFrameworks",
        "-nologo",
      ],
      {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        // SDK selection reads global.json from the working directory.
        cwd: ResolveDotnetContext(projectPath).WorkingDirectory,
      }
    );

    return this.ParseMsBuildOutput(stdout);
  }

  static ParseMsBuildOutput(stdout: string): string[] {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return [];
    }

    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1)) as {
        Properties?: Record<string, string>;
      };

      const multi = parsed.Properties?.["TargetFrameworks"]?.trim() ?? "";
      if (multi) {
        return this.normalizeFrameworks(multi.split(";"));
      }

      const single = parsed.Properties?.["TargetFramework"]?.trim() ?? "";
      return single ? this.normalizeFrameworks([single]) : [];
    } catch {
      return [];
    }
  }

  private static withOverrides(
    info: TargetFrameworkInfo,
    overrides: string[]
  ): TargetFrameworkInfo {
    const normalizedOverrides = this.normalizeFrameworks(overrides);
    if (normalizedOverrides.length === 0) {
      return info;
    }

    const merged = this.normalizeFrameworks([...info.Frameworks, ...normalizedOverrides]);
    return merged.length === info.Frameworks.length
      ? info
      : { Frameworks: merged, Source: info.Frameworks.length === 0 ? "override" : info.Source };
  }

  private static normalizeFrameworks(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed || trimmed.includes("$(")) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
    return result;
  }

  private static async BuildCacheKeyAsync(projectPath: string): Promise<string> {
    const files = new Set<string>([
      projectPath,
      path.join(path.dirname(projectPath), "obj", "project.assets.json"),
    ]);
    let current = path.dirname(projectPath);
    const root = path.parse(current).root;

    while (current !== root) {
      for (const name of CONFIG_FILES) {
        const candidate = path.join(current, name);
        if (fs.existsSync(candidate)) {
          files.add(candidate);
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    const parts: string[] = [];
    for (const file of files) {
      try {
        const stat = await fs.promises.stat(file);
        parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        parts.push(`${file}:missing`);
      }
    }
    return [...parts].sort(compareStrings).join("|");
  }

  private static normalize(projectPath: string): string {
    return path.normalize(projectPath).toLowerCase();
  }

  private static async acquireEvaluationSlotAsync(): Promise<void> {
    if (this.activeEvaluations < this.MAX_CONCURRENT_EVALUATIONS) {
      this.activeEvaluations++;
      return;
    }
    await new Promise<void>((resolve) => this.evaluationQueue.push(resolve));
  }

  private static releaseEvaluationSlot(): void {
    const next = this.evaluationQueue.shift();
    if (next) {
      // Transfer the slot to the next waiter without decrementing.
      next();
      return;
    }
    this.activeEvaluations = Math.max(0, this.activeEvaluations - 1);
  }
}
