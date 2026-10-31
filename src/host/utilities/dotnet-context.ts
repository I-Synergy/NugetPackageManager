/**
 * Resolves the directory a `dotnet` child process must run in.
 *
 * SDK selection is performed by the `dotnet` host from its **current working
 * directory**: it walks up looking for `global.json` and pins the SDK from the
 * nearest one. Passing an absolute project path in `argv` does not affect that
 * lookup, so a child spawned from the extension-host directory silently ignores
 * the solution's `global.json` and picks the newest installed SDK — which is how
 * a machine with a broken preview SDK fails every restore even though the
 * solution pins a healthy one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SelectDotnetCommand } from "./sdk-locations";

export interface GlobalJsonSettings {
    /** `sdk.version`, the SDK band the solution pins. */
    Version?: string;
    RollForward?: string;
    AllowPrerelease?: boolean;
}

export interface DotnetContext {
    /** Directory the dotnet process must be spawned in. */
    WorkingDirectory: string;
    /** Nearest `global.json` at or above the project, when one exists. */
    GlobalJsonPath?: string;
    /** `sdk.version` from that file, when declared. */
    PinnedSdkVersion?: string;
    /** The `dotnet` host to run (`dotnet`, or the extension's private install). */
    Command: string;
}

const MAX_WALK_DEPTH = 32;

/**
 * Removes `//` and block comments and trailing commas so `global.json` files
 * written for the SDK's tolerant JSON reader parse with `JSON.parse`.
 * String contents are preserved.
 */
export function StripJsonCommentsAndTrailingCommas(text: string): string {
    return RemoveComments(text).replace(/,(\s*[}\]])/g, "$1");
}

/** Copies the text, dropping `//` and block comments; string contents are kept. */
function RemoveComments(text: string): string {
    let result = "";
    let index = 0;
    while (index < text.length) {
        const char = text[index]!;
        if (char === '"') {
            const end = ScanString(text, index);
            result += text.slice(index, end);
            index = end;
            continue;
        }
        if (char === "/" && text[index + 1] === "/") {
            index = SkipLineComment(text, index) + 1;
            result += "\n";
            continue;
        }
        if (char === "/" && text[index + 1] === "*") {
            index = SkipBlockComment(text, index);
            continue;
        }
        result += char;
        index++;
    }
    return result;
}

/** Index just past the closing quote of the string that opens at `start`. */
function ScanString(text: string, start: number): number {
    let index = start + 1;
    while (index < text.length) {
        const char = text[index];
        if (char === "\\") {
            index += 2;
            continue;
        }
        index++;
        if (char === '"') return index;
    }
    return text.length;
}

function SkipLineComment(text: string, start: number): number {
    let index = start;
    while (index < text.length && text[index] !== "\n") index++;
    return index;
}

function SkipBlockComment(text: string, start: number): number {
    let index = start + 2;
    while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
    return index + 2;
}

/** Parses the `sdk` section of a `global.json`. Returns `null` when unreadable. */
export function ParseGlobalJson(content: string): GlobalJsonSettings | null {
    try {
        const parsed = JSON.parse(
            StripJsonCommentsAndTrailingCommas(content.replace(/^\uFEFF/, ""))
        ) as { sdk?: Record<string, unknown> } | null;
        const sdk = parsed?.sdk;
        if (!sdk || typeof sdk !== "object") return null;

        const settings: GlobalJsonSettings = {};
        if (typeof sdk["version"] === "string") settings.Version = sdk["version"];
        if (typeof sdk["rollForward"] === "string") settings.RollForward = sdk["rollForward"];
        if (typeof sdk["allowPrerelease"] === "boolean") settings.AllowPrerelease = sdk["allowPrerelease"];
        return settings;
    } catch {
        return null;
    }
}

/** Finds the nearest `global.json` at or above `startDirectory`. */
export function FindGlobalJsonUpwards(
    startDirectory: string,
    stopAt?: string
): string | null {
    let current = path.resolve(startDirectory);
    const stop = stopAt ? path.resolve(stopAt) : null;

    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
        const candidate = path.join(current, "global.json");
        if (fs.existsSync(candidate)) return candidate;

        if (stop && current.toLowerCase() === stop.toLowerCase()) return null;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }

    return null;
}

/**
 * The context for running `dotnet` against `projectPath`: the directory that
 * contains the nearest `global.json` (so the pin applies), otherwise the
 * project directory.
 */
export function ResolveDotnetContext(projectPath: string): DotnetContext {
    const projectDirectory = path.dirname(path.resolve(projectPath));
    const globalJsonPath = FindGlobalJsonUpwards(projectDirectory);

    if (!globalJsonPath) {
        return { WorkingDirectory: projectDirectory, Command: "dotnet" };
    }

    const workingDirectory = path.dirname(globalJsonPath);
    const pinnedSdkVersion = ReadPinnedSdkVersion(globalJsonPath);
    const context: DotnetContext = {
        WorkingDirectory: workingDirectory,
        GlobalJsonPath: globalJsonPath,
        Command: SelectDotnetCommand(pinnedSdkVersion),
    };
    if (pinnedSdkVersion) context.PinnedSdkVersion = pinnedSdkVersion;
    return context;
}

/** `sdk.version` from a `global.json`, tolerating comments and a BOM. */
export function ReadPinnedSdkVersion(globalJsonPath: string | null): string | undefined {
    if (!globalJsonPath) return undefined;
    try {
        return ParseGlobalJson(fs.readFileSync(globalJsonPath, "utf8"))?.Version;
    } catch {
        return undefined;
    }
}

/** Context for commands that are not tied to a project (health checks, scans). */
export function ResolveWorkingDirectory(startDirectory: string): string {
    const absolute = path.resolve(startDirectory);
    const globalJsonPath = FindGlobalJsonUpwards(absolute);
    return globalJsonPath ? path.dirname(globalJsonPath) : absolute;
}

/** `dotnet` host to run for the SDK `startDirectory` would select. */
export function ResolveDotnetCommand(startDirectory: string): string {
    return SelectDotnetCommand(ReadPinnedSdkVersion(FindGlobalJsonUpwards(startDirectory)));
}
