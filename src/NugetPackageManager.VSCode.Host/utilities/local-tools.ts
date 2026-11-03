/**
 * Local .NET tool support for the host (`.config/dotnet-tools.json`).
 *
 * The split follows `evaluateToolchain`: the core owns manifest discovery, parsing, the targeted
 * rewrite and the latest-version lookup, while the host owns every `dotnet` spawn and every piece
 * of machine state. That leaves two host responsibilities here:
 *
 * - The restore probe. `dotnet tool list --local` only reads the manifest, so it cannot prove the
 *   tool was downloaded; the cheapest authoritative-enough signal is the tool package sitting in
 *   the global packages folder. It stays explicitly best-effort: an unreadable folder reports
 *   "not missing" (unknown), never an error.
 * - `dotnet tool restore` after a manifest edit, run in the manifest's own directory because a
 *   nested manifest is only found from there. A failed restore keeps the manifest change and says
 *   so; it never rolls back silently.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getSetting } from "@/common/configuration";
import { Logger } from "@/common/logger";
import type {
    GetLocalToolsRequest,
    GetLocalToolsResponse,
    LocalTool,
    LocalToolManifest,
    UpdateLocalToolRequest,
    UpdateLocalToolResponse,
} from "@/common/rpc/types";
import { CoreError } from "@/host/nuget/core-error";
import coreProcess from "@/host/nuget/core-process";
import { ReadProxyUrl } from "@/host/nuget/api-factory";
import NuGetConfigResolver from "./nuget-config-resolver";
import { ResolveDotnetContext } from "./dotnet-context";
import { RunCapturedAsync, type CommandResult, type ToolchainLocalToolProbe } from "./toolchain-health";
import { isPathInWorkspaceAsync } from "./workspace-path";
import { applyExcludeGlobs } from "./workspace-exclusions";

/** The file name a local tool manifest always has; the core refuses anything else. */
const MANIFEST_FILE_NAME = "dotnet-tools.json";

/** `dotnet tool restore` downloads packages; give it the same room a restore gets elsewhere. */
const RESTORE_TIMEOUT_MS = 120_000;

const MAX_RESTORE_MESSAGE_CHARS = 2_000;

/** Spawn failures that mean the child was killed by the timeout instead of failing on its own. */
const TIMEOUT_SPAWN_CODES = new Set(["ETIMEDOUT", "ESIGTERM", "SIGTERM", "SIGKILL"]);

type ResolvedSource = Awaited<
    ReturnType<typeof NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync>
>[number];

/** The wire shape of one `sources` entry, exactly as `computeRequirementClosure` sends it. */
function toSourceWire(source: ResolvedSource): {
    url: string;
    username?: string;
    password?: string;
    proxy?: string;
} {
    const proxy = ReadProxyUrl();
    return {
        url: source.Url,
        ...(source.Username !== undefined && { username: source.Username }),
        ...(source.Password !== undefined && { password: source.Password }),
        ...(proxy !== undefined && { proxy }),
    };
}

/**
 * The workspace roots for a request the webview sent.
 *
 * The webview posts `WorkspaceRoots: []` because it cannot know them; the host answers with the
 * same folders `getWorkspaceRoots()` uses, which is why this mirrors it rather than importing
 * `host-api` (that module imports this one).
 */
function resolveWorkspaceRoots(requested: string[] | undefined): string[] {
    if (requested && requested.length > 0) return requested;
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/**
 * The NuGet sources to resolve latest versions from, resolved the way the outdated scan does.
 *
 * Only when the core will actually contact them: `ResolveLatest: false` must stay offline, and
 * decoding passwords can run a password script.
 */
async function resolveSourcesAsync(workspaceRoots: string[]): Promise<ResolvedSource[]> {
    try {
        return await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);
    } catch (err) {
        Logger.warn("readLocalTools: NuGet sources could not be resolved; using the core's defaults", err);
        return [];
    }
}

/** The global packages folder NuGet would use, honouring `NUGET_PACKAGES`. */
export function ResolveGlobalPackagesFolder(): string {
    const configured = process.env.NUGET_PACKAGES?.trim();
    if (configured) return configured;
    return path.join(os.homedir(), ".nuget", "packages");
}

/**
 * True when the tool package is absent from the global packages folder.
 *
 * NuGet lower-cases the package id and keeps the version as written, so the probe does the same.
 * Best effort by design: when the folder itself cannot be read the answer is `false` (unknown),
 * because claiming every tool is missing would be worse than saying nothing.
 */
export function IsToolPackageMissing(
    id: string,
    version: string,
    packagesFolder: string = ResolveGlobalPackagesFolder()
): boolean {
    if (!id || !version) return false;

    try {
        if (!fs.statSync(packagesFolder).isDirectory()) return false;
    } catch {
        return false;
    }

    try {
        return !fs.statSync(path.join(packagesFolder, id.toLowerCase(), version)).isDirectory();
    } catch {
        return true;
    }
}

/**
 * The directory an exclusion rule is matched against for a manifest: the folder that owns the
 * manifest's `.config`, i.e. the project (or cached repository) the manifest belongs to.
 *
 * The manifest path itself is never matched on purpose: it always contains the hidden `.config`
 * segment, so the default glob that excludes hidden folders would exclude every manifest.
 */
function ExcludedPathOf(manifest: LocalToolManifest): string {
    return manifest.Path ? path.dirname(path.dirname(manifest.Path)) : "";
}

/** Fills the host-owned `NotRestored` flag the core always answers as `false`. */
function withRestoreState(manifest: LocalToolManifest): LocalToolManifest {
    const tools: LocalTool[] = (manifest.Tools ?? []).map((tool) => ({
        ...tool,
        NotRestored: IsToolPackageMissing(tool.Id, tool.Version),
    }));
    return { ...manifest, Tools: tools };
}

/**
 * Every manifest in the workspace with its tools, the pinned versions and — when
 * `ResolveLatest` is not `false` — the latest eligible version per tool.
 *
 * Throws only a described `Error`; the `HostAPI` method turns it into `fail(...)`.
 */
export async function ReadLocalToolsAsync(
    request: GetLocalToolsRequest,
    signal?: AbortSignal
): Promise<GetLocalToolsResponse> {
    const workspaceRoots = resolveWorkspaceRoots(request.WorkspaceRoots);
    if (workspaceRoots.length === 0) {
        // No folder is open: there is nothing to locate a manifest from.
        return { Manifests: [] };
    }

    const resolveLatest = request.ResolveLatest !== false;
    const sources = resolveLatest ? await resolveSourcesAsync(workspaceRoots) : [];

    let response: GetLocalToolsResponse;
    try {
        response = await coreProcess.CallAsync<GetLocalToolsResponse>(
            "readLocalTools",
            {
                workspaceRoots,
                ...(request.ProjectPaths?.length ? { projectPaths: request.ProjectPaths } : {}),
                ...(request.Prerelease === true && { prerelease: true }),
                resolveLatest,
                ...(request.ForceRefresh === true && { forceRefresh: true }),
                ...(sources.length > 0 && { sources: sources.map(toSourceWire) }),
            },
            signal
        );
    } catch (err) {
        throw new Error(describeLocalToolFailure(err, "readLocalTools"));
    }

    const discovered = response?.Manifests ?? [];
    const manifests = applyExcludeGlobs(
        discovered.map((manifest) => ({ manifest, fsPath: ExcludedPathOf(manifest) })),
        getSetting<string[]>("excludeGlobs", [])
    ).map((entry) => withRestoreState(entry.manifest));
    const dropped = discovered.length - manifests.length;
    if (dropped > 0) {
        Logger.debug(`readLocalTools: dropped ${dropped} manifest(s) in excluded folders`);
    }
    const notRestored = manifests.reduce(
        (count, manifest) => count + manifest.Tools.filter((tool) => tool.NotRestored).length,
        0
    );
    Logger.debug(
        `readLocalTools: ${manifests.length} manifest(s), ${notRestored} tool(s) not restored ` +
            `(resolveLatest=${resolveLatest})`
    );
    return { Manifests: manifests };
}

/**
 * Pins one tool at a new version, then restores it.
 *
 * Order matters: the manifest write is the user's explicit edit and stays, so a failed restore is
 * reported next to it instead of being undone. `Restore` is never null here — the restore is
 * always attempted once the edit landed.
 */
export async function UpdateLocalToolAsync(
    request: UpdateLocalToolRequest,
    signal?: AbortSignal
): Promise<UpdateLocalToolResponse> {
    const workspaceRoots = resolveWorkspaceRoots(request.WorkspaceRoots);
    const manifestPath = await validateManifestPathAsync(request.ManifestPath, workspaceRoots);

    if (!request.ToolId?.trim()) throw new Error("A tool id is required.");
    if (!request.Version?.trim()) throw new Error("A version is required.");
    if (!request.ExpectedVersion?.trim()) {
        throw new Error("The version the row was rendered from is required.");
    }

    let updated: UpdateLocalToolResponse;
    try {
        updated = await coreProcess.CallAsync<UpdateLocalToolResponse>(
            "updateLocalTool",
            {
                manifestPath,
                toolId: request.ToolId,
                expectedVersion: request.ExpectedVersion,
                version: request.Version,
                workspaceRoots,
            },
            signal
        );
    } catch (err) {
        throw new Error(describeLocalToolFailure(err, "updateLocalTool"));
    }

    const written = updated?.ManifestPath ?? manifestPath;
    const restore = await RestoreToolsAsync(written);
    Logger.info(
        `updateLocalTool: ${updated?.ToolId ?? request.ToolId} ` +
            `${updated?.PreviousVersion ?? request.ExpectedVersion} -> ${updated?.Version ?? request.Version} ` +
            `restored=${restore.Ok}`
    );

    return {
        ManifestPath: written,
        ToolId: updated?.ToolId ?? request.ToolId,
        PreviousVersion: updated?.PreviousVersion ?? request.ExpectedVersion,
        Version: updated?.Version ?? request.Version,
        Restore: restore,
    };
}

/**
 * `dotnet tool restore` in the manifest's own directory: a nested manifest is only discovered
 * from its folder, and the SDK selection follows that folder's nearest `global.json`.
 */
export async function RestoreToolsAsync(
    manifestPath: string
): Promise<NonNullable<UpdateLocalToolResponse["Restore"]>> {
    const manifestDirectory = path.dirname(manifestPath);
    const command = ResolveDotnetContext(manifestPath).Command;
    const result = await RunCapturedAsync(
        command,
        ["tool", "restore"],
        manifestDirectory,
        RESTORE_TIMEOUT_MS
    );

    if (result.Code === 0 && result.SpawnError === undefined) {
        return { Ok: true, TimedOut: false };
    }

    const timedOut = result.SpawnError !== undefined && TIMEOUT_SPAWN_CODES.has(result.SpawnError);
    return {
        Ok: false,
        TimedOut: timedOut,
        Message: describeRestoreFailure(result, timedOut),
    };
}

/**
 * The probe slice `evaluateToolchain` reads: one entry per manifest, each tool carrying the
 * restore state this machine reported.
 */
export function BuildLocalToolProbeSlice(manifests: LocalToolManifest[]): ToolchainLocalToolProbe[] {
    return manifests
        .filter((manifest) => Boolean(manifest.Path))
        .map((manifest) => ({
            manifestPath: manifest.Path,
            problems: manifest.Problems ?? [],
            tools: (manifest.Tools ?? []).map((tool) => ({
                id: tool.Id,
                version: tool.Version,
                restored: !tool.NotRestored,
            })),
        }));
}

/**
 * The manifest path, once it is absolute, names `dotnet-tools.json` and sits inside a workspace
 * root. The core repeats these checks (it edits the file); the host checks first so the user gets
 * the failure before any write, exactly like the other write paths.
 */
async function validateManifestPathAsync(
    manifestPath: string,
    workspaceRoots: string[]
): Promise<string> {
    const candidate = manifestPath?.trim() ?? "";
    if (candidate.length === 0) throw new Error("A tool manifest path is required.");
    if (!path.isAbsolute(candidate)) {
        throw new Error(`The tool manifest path must be absolute: ${candidate}`);
    }
    if (path.basename(candidate).toLowerCase() !== MANIFEST_FILE_NAME) {
        throw new Error(`The tool manifest path must name a ${MANIFEST_FILE_NAME} file: ${candidate}`);
    }
    if (workspaceRoots.length === 0) {
        throw new Error("No workspace folder is open, so the tool manifest cannot be validated.");
    }
    if (!(await isPathInWorkspaceAsync(candidate, workspaceRoots))) {
        throw new Error(`The tool manifest is outside the workspace: ${candidate}`);
    }
    return path.resolve(candidate);
}

function describeRestoreFailure(result: CommandResult, timedOut: boolean): string {
    const output = trimRestoreOutput(result);
    const seconds = Math.round(RESTORE_TIMEOUT_MS / 1000);

    if (timedOut) {
        const headline = `dotnet tool restore did not finish within ${seconds} s.`;
        return output ? `${headline}\n${output}` : headline;
    }
    if (output) return output;
    if (result.SpawnError) return `dotnet could not be started (${result.SpawnError}).`;
    return `dotnet tool restore failed (exit code ${result.Code ?? "unknown"}).`;
}

function trimRestoreOutput(result: CommandResult): string {
    const raw = (result.Stderr.trim() || result.Stdout.trim()).replace(/\r\n/g, "\n");
    return raw.length > MAX_RESTORE_MESSAGE_CHARS
        ? `${raw.slice(0, MAX_RESTORE_MESSAGE_CHARS)}…`
        : raw;
}

/**
 * Core failures arrive as `CoreError` with a stable code; the codes the tool handlers define get
 * a sentence a user can act on, everything else keeps the core's own message.
 */
function describeLocalToolFailure(err: unknown, operation: string): string {
    if (err instanceof CoreError) {
        switch (err.code) {
            case "manifestNotFound":
                return "The tool manifest no longer exists. Reload the Repo tools card and try again.";
            case "toolNotFound":
                return "That tool is no longer declared in the manifest. Reload and try again.";
            case "invalidManifest":
                return `The tool manifest could not be updated: ${err.message}`;
            case "invalidVersion":
                return `That is not a valid tool version: ${err.message}`;
            case "versionMismatch":
                return "The manifest changed since this row was rendered. Reload and try again.";
            case "fileChanged":
                return "The manifest was edited while the update ran. Reload and try again.";
            case "verificationFailed":
                return `The update could not be verified, so the manifest was left untouched: ${err.message}`;
            case "unavailable":
                return err.message;
            case "InvalidParams":
            case "invalidParams":
                return err.message;
            default:
                return `${operation} failed: ${err.message}`;
        }
    }
    if (err instanceof Error) return err.message;
    return String(err);
}
