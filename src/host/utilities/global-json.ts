/**
 * Writes the SDK pin into `global.json` — the file `dotnet` itself reads.
 *
 * A pin is only coherent if the rest of the file agrees with it, so the update
 * also:
 *  - sets `sdk.allowPrerelease` for a prerelease version (otherwise the pin can
 *    never resolve),
 *  - drops `sdk.workloadVersion` when it pins a workload set for a different
 *    feature band (a 10.0.400 workload set under an 11.0.100 SDK is what makes
 *    MSBuild fail with `WorkloadManifestCompositionException`),
 *  - keeps `tools.dotnet` in step with the pinned SDK.
 *
 * The edit is surgical when possible — only the affected properties change, so
 * comments, key order and unrelated sections survive — and the result is parsed
 * back before it is written. A patch that does not verify falls back to a
 * canonical rewrite of the merged object.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
    FindGlobalJsonUpwards,
    ParseGlobalJson,
    StripJsonCommentsAndTrailingCommas,
} from "./dotnet-context";

export interface GlobalJsonUpdateOptions {
    /** Directory to start the upward search for `global.json` from. */
    StartDirectory: string;
    /** Installed SDK version to pin. */
    Version: string;
}

const execFileAsync = promisify(execFile);
const TEMPLATE_TIMEOUT_MS = 60_000;

export interface GlobalJsonCreateOptions extends GlobalJsonUpdateOptions {
    /** `dotnet` host used for the official `globaljson` template. */
    Command?: string;
}

export interface GlobalJsonUpdateResult {
    GlobalJsonPath: string;
    /** True when the file did not exist and was created. */
    Created: boolean;
    /** False when the file already pinned this version with a coherent file. */
    Changed: boolean;
    PreviousVersion?: string;
    /** Human-readable list of the other properties that were adjusted. */
    Notes: string[];
    /** `template` = created with `dotnet new globaljson`; `edit` = written here. */
    Source?: "template" | "edit";
}

const SDK_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Accepts only a concrete SDK version (`10.0.403`, `11.0.100-rc.3.26522.148`). */
export function IsValidSdkVersion(version: string): boolean {
    return SDK_VERSION_RE.test(version.trim());
}

/**
 * Feature band of an SDK or workload-set version: `10.0.403` and `10.0.401.1`
 * both belong to `10.0.400`; `11.0.100-rc.3...` belongs to `11.0.100`.
 */
export function FeatureBand(version: string): string {
    const numeric = version.trim().split("-")[0] ?? version;
    const [major = "", minor = "", patchText = "0"] = numeric.split(".");
    const patch = Number.parseInt(patchText, 10);
    const band = Number.isFinite(patch) ? patch - (patch % 100) : 0;
    return `${major}.${minor}.${band}`;
}

function IsPrerelease(version: string): boolean {
    return version.includes("-");
}

/** Range of the `{...}` object that follows `"key"`, string-literal aware. */
function FindObjectRange(text: string, key: string): { start: number; end: number } | null {
    const keyIndex = text.indexOf(`"${key}"`);
    if (keyIndex < 0) return null;
    const start = text.indexOf("{", keyIndex);
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth++;
        else if (char === "}") {
            depth--;
            if (depth === 0) return { start, end: index + 1 };
        }
    }
    return null;
}

function ReplaceStringProperty(slice: string, key: string, value: string): string {
    return slice.replace(
        new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`),
        `$1${value}$2`
    );
}

function ReadBooleanProperty(slice: string, key: string): boolean | undefined {
    const match = new RegExp(`"${key}"\\s*:\\s*(true|false)`).exec(slice);
    if (!match?.[1]) return undefined;
    return match[1] === "true";
}

function SetBooleanProperty(slice: string, key: string, value: boolean): string {
    return slice.replace(new RegExp(`("${key}"\\s*:\\s*)(true|false)`), `$1${value}`);
}

function HasStringProperty(slice: string, key: string): boolean {
    return new RegExp(`"${key}"\\s*:\\s*"`).test(slice);
}

function ReadStringProperty(slice: string, key: string): string | undefined {
    return new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(slice)?.[1];
}

function InsertStringPropertyAfter(
    slice: string,
    afterKey: string,
    key: string,
    value: string
): string {
    return slice.replace(
        new RegExp(`("${afterKey}"\\s*:\\s*"[^"]*")`),
        `$1,\n    "${key}": "${value}"`
    );
}

function RemoveStringProperty(slice: string, key: string): string {
    const trailing = new RegExp(`\\s*"${key}"\\s*:\\s*"[^"]*"\\s*,`, "g");
    let result = slice;
    if (trailing.test(result)) {
        result = result.replace(trailing, "");
    } else {
        result = result.replace(new RegExp(`,\\s*"${key}"\\s*:\\s*"[^"]*"`, "g"), "");
    }
    return result.replace(/,\s*}/g, "}");
}

interface CoherencePlan {
    setAllowPrerelease: boolean;
    /** Previous `sdk.rollForward`, when it is not already `disable`. */
    setRollForward?: string;
    removeWorkloadVersion?: string;
    updateToolsDotnet?: string;
    notes: string[];
}

function PlanCoherence(
    sdkSlice: string | null,
    toolsSlice: string | null,
    version: string
): CoherencePlan {
    const notes: string[] = [];
    const plan: CoherencePlan = { setAllowPrerelease: false, notes };

    if (sdkSlice) {
        const allowPrerelease = ReadBooleanProperty(sdkSlice, "allowPrerelease");
        if (IsPrerelease(version) && allowPrerelease === false) {
            plan.setAllowPrerelease = true;
            notes.push("sdk.allowPrerelease set to true for a prerelease SDK");
        }

        // A pin selects one exact SDK: rolling forward would silently use a
        // different one than the selector shows.
        const rollForward = ReadStringProperty(sdkSlice, "rollForward");
        if (rollForward !== "disable") {
            plan.setRollForward = rollForward ?? "(unset)";
            notes.push(
                rollForward
                    ? `sdk.rollForward set to disable (was ${rollForward})`
                    : "sdk.rollForward set to disable"
            );
        }

        const workloadVersion = ReadStringProperty(sdkSlice, "workloadVersion");
        if (workloadVersion && FeatureBand(workloadVersion) !== FeatureBand(version)) {
            plan.removeWorkloadVersion = workloadVersion;
            notes.push(
                `removed sdk.workloadVersion ${workloadVersion} (band ${FeatureBand(workloadVersion)}; the selected SDK is ${FeatureBand(version)})`
            );
        }
    }

    if (toolsSlice) {
        const toolsDotnet = ReadStringProperty(toolsSlice, "dotnet");
        if (toolsDotnet && toolsDotnet !== version) {
            plan.updateToolsDotnet = toolsDotnet;
            notes.push(`tools.dotnet updated from ${toolsDotnet} to ${version}`);
        }
    }

    return plan;
}

function ApplyPlan(
    text: string,
    plan: CoherencePlan,
    version: string
): string {
    let result = text;

    const sdkRange = FindObjectRange(result, "sdk");
    if (sdkRange) {
        let sdkSlice = result.slice(sdkRange.start, sdkRange.end);
        sdkSlice = HasStringProperty(sdkSlice, "version")
            ? ReplaceStringProperty(sdkSlice, "version", version)
            : sdkSlice.replace("{", `{\n    "version": "${version}",`);
        if (plan.setRollForward) {
            sdkSlice = HasStringProperty(sdkSlice, "rollForward")
                ? ReplaceStringProperty(sdkSlice, "rollForward", "disable")
                : InsertStringPropertyAfter(sdkSlice, "version", "rollForward", "disable");
        }
        if (plan.setAllowPrerelease) {
            sdkSlice = SetBooleanProperty(sdkSlice, "allowPrerelease", true);
        }
        if (plan.removeWorkloadVersion) {
            sdkSlice = RemoveStringProperty(sdkSlice, "workloadVersion");
        }
        result = result.slice(0, sdkRange.start) + sdkSlice + result.slice(sdkRange.end);
    }

    const toolsRange = FindObjectRange(result, "tools");
    if (toolsRange && plan.updateToolsDotnet) {
        const toolsSlice = result.slice(toolsRange.start, toolsRange.end);
        const updated = ReplaceStringProperty(toolsSlice, "dotnet", version);
        result = result.slice(0, toolsRange.start) + updated + result.slice(toolsRange.end);
    }

    return result;
}

function CanonicalJson(original: string, version: string, plan: CoherencePlan): string {
    let parsed: Record<string, unknown> = {};
    try {
        const candidate = JSON.parse(StripJsonCommentsAndTrailingCommas(original.replace(/^\uFEFF/, "")));
        if (candidate && typeof candidate === "object") parsed = candidate as Record<string, unknown>;
    } catch {
        parsed = {};
    }

    const sdk = typeof parsed["sdk"] === "object" && parsed["sdk"] !== null
        ? { ...(parsed["sdk"] as Record<string, unknown>) }
        : {};
    sdk["version"] = version;
    if (plan.setRollForward || sdk["rollForward"] === undefined) sdk["rollForward"] = "disable";
    if (plan.setAllowPrerelease) sdk["allowPrerelease"] = true;
    if (plan.removeWorkloadVersion) delete sdk["workloadVersion"];
    parsed["sdk"] = sdk;

    if (plan.updateToolsDotnet && typeof parsed["tools"] === "object" && parsed["tools"] !== null) {
        parsed["tools"] = { ...(parsed["tools"] as Record<string, unknown>), dotnet: version };
    }

    return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** True when the written text pins `version` and honours the coherence plan. */
function IsCoherent(content: string, version: string, plan: CoherencePlan): boolean {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(StripComments(content)) as Record<string, unknown>;
    } catch {
        return false;
    }
    const sdk = parsed["sdk"] as Record<string, unknown> | undefined;
    if (sdk?.["version"] !== version) return false;

    if (sdk["rollForward"] !== "disable") return false;
    if (plan.setAllowPrerelease && sdk["allowPrerelease"] !== true) return false;
    if (plan.removeWorkloadVersion && "workloadVersion" in sdk) return false;

    if (plan.updateToolsDotnet) {
        const tools = parsed["tools"] as Record<string, unknown> | undefined;
        if (tools?.["dotnet"] !== version) return false;
    }
    return true;
}

function StripComments(content: string): string {
    return StripJsonCommentsAndTrailingCommas(content.replace(/^\uFEFF/, ""));
}

/**
 * Pins `options.Version` in the nearest `global.json`, creating one at
 * `StartDirectory` when the workspace has none, and keeps the rest of the file
 * consistent with that pin.
 */
export function UpdateGlobalJsonSdkVersion(options: GlobalJsonUpdateOptions): GlobalJsonUpdateResult {
    const version = options.Version.trim();
    if (!IsValidSdkVersion(version)) {
        throw new Error(`"${version}" is not a valid .NET SDK version.`);
    }

    const startDirectory = path.resolve(options.StartDirectory);
    const existing = FindGlobalJsonUpwards(startDirectory);
    const globalJsonPath = existing ?? path.join(startDirectory, "global.json");
    const original = existing ? fs.readFileSync(globalJsonPath, "utf8") : "";
    const previousVersion = ParseGlobalJson(original)?.Version;

    const sdkRange = FindObjectRange(original, "sdk");
    const toolsRange = FindObjectRange(original, "tools");
    const plan = PlanCoherence(
        sdkRange ? original.slice(sdkRange.start, sdkRange.end) : null,
        toolsRange ? original.slice(toolsRange.start, toolsRange.end) : null,
        version
    );

    const patched = original ? ApplyPlan(original, plan, version) : "";
    const content = patched && IsCoherent(patched, version, plan)
        ? patched
        : CanonicalJson(original, version, plan);

    if (!fs.existsSync(globalJsonPath) || content !== original) {
        fs.mkdirSync(path.dirname(globalJsonPath), { recursive: true });
        fs.writeFileSync(globalJsonPath, content, "utf8");
    }

    const changed = previousVersion !== version ||
        plan.setAllowPrerelease ||
        Boolean(plan.setRollForward) ||
        Boolean(plan.removeWorkloadVersion) ||
        Boolean(plan.updateToolsDotnet);

    return {
        GlobalJsonPath: globalJsonPath,
        Created: !existing,
        Changed: changed,
        ...(previousVersion ? { PreviousVersion: previousVersion } : {}),
        Notes: plan.notes,
        Source: "edit",
    };
}

/**
 * Creates a missing `global.json` with Microsoft's own template
 * (`dotnet new globaljson --sdk-version <v> --roll-forward disable`) and falls
 * back to the writer when the template is unavailable or produces something
 * unexpected. An existing file is never handed to the template — it would drop
 * unrelated sections such as `tools` and `test`.
 */
export async function UpdateGlobalJsonSdkVersionAsync(
    options: GlobalJsonCreateOptions
): Promise<GlobalJsonUpdateResult> {
    const startDirectory = path.resolve(options.StartDirectory);
    if (FindGlobalJsonUpwards(startDirectory)) {
        return UpdateGlobalJsonSdkVersion(options);
    }

    const created = await TryCreateWithTemplateAsync(
        startDirectory,
        options.Version.trim(),
        options.Command ?? "dotnet"
    );
    return created ?? UpdateGlobalJsonSdkVersion(options);
}

async function TryCreateWithTemplateAsync(
    directory: string,
    version: string,
    command: string
): Promise<GlobalJsonUpdateResult | null> {
    if (!IsValidSdkVersion(version)) return null;

    try {
        await execFileAsync(
            command,
            [
                "new",
                "globaljson",
                "--sdk-version",
                version,
                "--roll-forward",
                "disable",
                "--no-update-check",
                "--output",
                directory,
            ],
            { timeout: TEMPLATE_TIMEOUT_MS, windowsHide: true }
        );
    } catch {
        return null;
    }

    const globalJsonPath = path.join(directory, "global.json");
    try {
        const parsed = ParseGlobalJson(fs.readFileSync(globalJsonPath, "utf8"));
        if (parsed?.Version !== version) return null;
    } catch {
        return null;
    }

    return {
        GlobalJsonPath: globalJsonPath,
        Created: true,
        Changed: true,
        Notes: ["created with the official dotnet new globaljson template"],
        Source: "template",
    };
}
