import * as os from "node:os";
import coreProcess from "./core-process";

/**
 * NuGet config resolution over the C# core.
 *
 * The core owns discovery, XML parsing and merging, including the rule that `%VAR%` is expanded
 * only above workspace level. This module owns the wire shape: the core speaks camelCase JSON,
 * the host consumes PascalCase records like the rest of the NuGet surface.
 */

export type ResolvedConfigSource = {
    Name: string;
    Url: string;
    Username?: string;
    Password?: string;
    Patterns?: string[];
};

export type ConfigFailure = {
    Path: string;
    Message: string;
};

export type ResolvedConfig = {
    Sources: ResolvedConfigSource[];
    /** A workspace config used `<clear />`; the host must not add VS Code settings sources. */
    ClearFound: boolean;
    Failures: ConfigFailure[];
};

type WireSource = {
    name: string;
    url: string;
    username?: string;
    password?: string;
    patterns?: string[];
};

type WireResponse = {
    sources: WireSource[];
    clearFound: boolean;
    failures: Array<{ path: string; message: string }>;
};

export async function resolveNuGetConfigAsync(
    workspaceRoots: string[],
    signal?: AbortSignal
): Promise<ResolvedConfig> {
    const response = await coreProcess.CallAsync<WireResponse>(
        "resolveNuGetConfig",
        {
            workspaceRoots,
            platform: process.platform,
            homeDirectory: os.homedir(),
        },
        signal
    );

    return {
        Sources: response.sources.map((source) => ({
            Name: source.name,
            Url: source.url,
            ...(source.username !== undefined && source.username !== "" && { Username: source.username }),
            ...(source.password !== undefined && source.password !== "" && { Password: source.password }),
            ...(source.patterns !== undefined && source.patterns.length > 0 && { Patterns: source.patterns }),
        })),
        ClearFound: response.clearFound,
        Failures: response.failures.map((failure) => ({ Path: failure.path, Message: failure.message })),
    };
}
