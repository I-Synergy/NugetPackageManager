/**
 * Finds direct `PackageReference` entries that the restored graph already
 * provides transitively.
 *
 * Input is the official restore output (`obj/project.assets.json`): its
 * `targets[<tfm>]` section is the resolved graph and
 * `project.frameworks[<tfm>].dependencies` is the direct reference list. A direct
 * reference is only safe to remove when removing it would not lower the resolved
 * version — a direct reference that raises a version is an intentional pin and is
 * reported as such, never offered for removal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DependencyIssue } from "../../common/rpc/types";
import { RangeLowerBound } from "../../common/package-range";
import { compareVersions } from "./version";

export { RangeLowerBound };

export interface AssetsFile {
    version?: number;
    targets?: Record<string, Record<string, AssetsTargetEntry>>;
    libraries?: Record<string, { type?: string }>;
    project?: {
        frameworks?: Record<string, { dependencies?: Record<string, AssetsDirectDependency> }>;
    };
}

interface AssetsTargetEntry {
    type?: string;
    dependencies?: Record<string, string>;
}

interface AssetsDirectDependency {
    target?: string;
    version?: string;
}

interface GraphNode {
    id: string;
    version: string;
    dependencies: Map<string, string>;
}

const PACKAGE_KEY_RE = /^(.+)\/([^/]+)$/;

/** Splits `PackageId/1.2.3` into its parts. */
export function SplitPackageKey(key: string): { id: string; version: string } | null {
    const match = PACKAGE_KEY_RE.exec(key);
    if (!match?.[1] || !match[2]) return null;
    return { id: match[1], version: match[2] };
}

function BuildGraph(target: Record<string, AssetsTargetEntry>): Map<string, GraphNode> {
    const nodes = new Map<string, GraphNode>();
    for (const [key, entry] of Object.entries(target)) {
        if (entry.type && entry.type !== "package") continue;
        const parts = SplitPackageKey(key);
        if (!parts) continue;
        const dependencies = new Map<string, string>();
        for (const [id, range] of Object.entries(entry.dependencies ?? {})) {
            dependencies.set(id, range);
        }
        nodes.set(parts.id, { id: parts.id, version: parts.version, dependencies });
    }
    return nodes;
}

/** Highest lower bound any edge in the graph requires for `packageId`. */
function HighestRequiredVersion(graph: Map<string, GraphNode>, packageId: string): string | null {
    let highest: string | null = null;
    for (const node of graph.values()) {
        const range = node.dependencies.get(packageId);
        if (!range) continue;
        const lower = RangeLowerBound(range);
        if (!lower) return null;
        if (highest === null || compareVersions(lower, highest) > 0) highest = lower;
    }
    return highest;
}

/** Shortest chain of package ids from any of `roots` to `target`. */
function FindChain(
    graph: Map<string, GraphNode>,
    roots: string[],
    target: string
): string[] | null {
    const visited = new Set<string>(roots);
    const queue: Array<{ id: string; path: string[] }> = roots.map((id) => ({ id, path: [id] }));

    while (queue.length > 0) {
        const current = queue.shift()!;
        const node = graph.get(current.id);
        if (!node) continue;
        for (const dependencyId of node.dependencies.keys()) {
            if (dependencyId === target) return [...current.path, dependencyId];
            if (visited.has(dependencyId)) continue;
            visited.add(dependencyId);
            queue.push({ id: dependencyId, path: [...current.path, dependencyId] });
        }
    }
    return null;
}

/**
 * Package ids the project references **directly** for `tfm` (lower-cased).
 *
 * These are the packages NuGet cannot raise on its own: their version is set by
 * the project (or its central pin), so a newer requirement becomes a real
 * conflict. Transitive packages, by contrast, resolve upward automatically.
 */
export function ReadDirectDependencies(assets: AssetsFile, tfm: string): Set<string> {
    const dependencies = assets.project?.frameworks?.[tfm]?.dependencies ?? {};
    return new Set(
        Object.entries(dependencies)
            .filter(([, dependency]) => !dependency.target || dependency.target === "Package")
            .map(([id]) => id.toLowerCase())
    );
}

/** Reads `project.assets.json` without the freshness checks (planning only). */
export async function ReadAssetsAsync(projectPath: string): Promise<AssetsFile | null> {
    try {
        const content = await fs.promises.readFile(
            path.join(path.dirname(projectPath), "obj", "project.assets.json"),
            "utf8"
        );
        return JSON.parse(content) as AssetsFile;
    } catch {
        return null;
    }
}

/** Direct references that are also reachable from another direct reference. */
export function AnalyzeAssets(assets: AssetsFile, projectPath: string): DependencyIssue[] {
    const issues = Object.entries(assets.targets ?? {}).flatMap(([tfm, target]) =>
        AnalyzeTarget(assets, tfm, target, projectPath)
    );
    return DedupeIssues(issues);
}

function AnalyzeTarget(
    assets: AssetsFile,
    tfm: string,
    target: Record<string, AssetsTargetEntry>,
    projectPath: string
): DependencyIssue[] {
    const graph = BuildGraph(target);
    const directIds = DirectPackageIds(assets, tfm).filter((id) => graph.has(id));
    if (directIds.length < 2) return [];

    const issues: DependencyIssue[] = [];
    const seen = new Set<string>();
    for (const id of directIds) {
        const issue = BuildIssue({ graph, directIds, id, seen, tfm, projectPath });
        if (issue) issues.push(issue);
    }
    return issues;
}

function DirectPackageIds(assets: AssetsFile, tfm: string): string[] {
    const directEntries = assets.project?.frameworks?.[tfm]?.dependencies ?? {};
    return Object.entries(directEntries)
        .filter(([, dependency]) => !dependency.target || dependency.target === "Package")
        .map(([id]) => id);
}

interface IssueInput {
    graph: Map<string, GraphNode>;
    directIds: string[];
    id: string;
    seen: Set<string>;
    tfm: string;
    projectPath: string;
}

function BuildIssue({ graph, directIds, id, seen, tfm, projectPath }: IssueInput): DependencyIssue | null {
    const node = graph.get(id);
    if (!node || seen.has(id)) return null;

    const chain = FindChain(graph, directIds.filter((root) => root !== id), id);
    if (!chain) return null;
    seen.add(id);

    const required = HighestRequiredVersion(graph, id);
    const isRedundant = required !== null && compareVersions(node.version, required) <= 0;

    return {
        ProjectPath: projectPath,
        Tfm: tfm,
        PackageId: id,
        DirectVersion: node.version,
        ResolvedVersion: node.version,
        Kind: isRedundant ? "Redundant" : "Pinned",
        Chain: chain.join(" -> "),
    };
}

/** One row per package per project; prefer the Redundant verdict when both TFMs disagree. */
function DedupeIssues(issues: DependencyIssue[]): DependencyIssue[] {
    const byPackage = new Map<string, DependencyIssue>();
    for (const issue of issues) {
        const existing = byPackage.get(issue.PackageId);
        if (!existing || (existing.Kind === "Pinned" && issue.Kind === "Redundant")) {
            byPackage.set(issue.PackageId, issue);
        }
    }
    return [...byPackage.values()].sort((a, b) => a.PackageId.localeCompare(b.PackageId, "en"));
}

export interface DependencyAnalysis {
    Issues: DependencyIssue[];
    Skipped: boolean;
    /** Why the project could not be analysed. */
    Reason?: string;
}

/** Reads `obj/project.assets.json`, rejecting stale files. */
export async function AnalyzeProjectAsync(projectPath: string): Promise<DependencyAnalysis> {
    const assetsPath = path.join(path.dirname(projectPath), "obj", "project.assets.json");
    try {
        const [assetsStat, projectStat] = await Promise.all([
            fs.promises.stat(assetsPath),
            fs.promises.stat(projectPath),
        ]);
        if (assetsStat.mtimeMs < projectStat.mtimeMs) {
            return { Issues: [], Skipped: true, Reason: "assets are older than the project; restore first" };
        }

        const propsPath = path.join(path.dirname(projectPath), "Directory.Packages.props");
        const propsStat = await fs.promises.stat(propsPath).catch(() => null);
        if (propsStat && assetsStat.mtimeMs < propsStat.mtimeMs) {
            return { Issues: [], Skipped: true, Reason: "assets are older than Directory.Packages.props; restore first" };
        }

        const parsed = JSON.parse(await fs.promises.readFile(assetsPath, "utf8")) as AssetsFile;
        return { Issues: AnalyzeAssets(parsed, projectPath), Skipped: false };
    } catch {
        return { Issues: [], Skipped: true, Reason: "project has not been restored" };
    }
}
