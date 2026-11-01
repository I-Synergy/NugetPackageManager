import { Logger } from "@/common/logger";
import type { DotnetFailureInfo } from "@/common/rpc/types";
import coreProcess from "@/host/nuget/core-process";

/**
 * Classifies raw `dotnet` output through the .NET core.
 *
 * The host still owns spawning, progress streaming and cancellation; the core only turns the
 * captured text plus the invocation context into a cause. Classification is diagnostics: if the
 * core cannot answer, an `Unknown` failure is returned rather than replacing the real error.
 */

export type { DotnetFailureKind } from "@/common/rpc/types";

export type DotnetFailure = DotnetFailureInfo;

export interface DotnetFailureContext {
  ProjectPath?: string;
  /** `sdk.version` pinned by the project's `global.json`, when known. */
  PinnedSdkVersion?: string;
  GlobalJsonPath?: string;
  /** `spawn` itself failed, e.g. `ENOENT` for a missing CLI. */
  SpawnFailed?: boolean;
}

const UNKNOWN_SUMMARY = "dotnet failed without a recognizable error.";
const UNKNOWN_HINT = "Open the NuGet Package Manager output channel for the full command output.";

export async function ClassifyDotnetFailureAsync(
  output: string,
  context: DotnetFailureContext = {}
): Promise<DotnetFailure> {
  try {
    return await coreProcess.CallAsync<DotnetFailure>("classifyDotnetFailure", {
      output,
      ...(context.ProjectPath !== undefined && { projectPath: context.ProjectPath }),
      ...(context.PinnedSdkVersion !== undefined && {
        pinnedSdkVersion: context.PinnedSdkVersion,
      }),
      ...(context.GlobalJsonPath !== undefined && { globalJsonPath: context.GlobalJsonPath }),
      ...(context.SpawnFailed !== undefined && { spawnFailed: context.SpawnFailed }),
    });
  } catch (err) {
    Logger.debug("ClassifyDotnetFailure: the core could not classify the output", err);
    return { Kind: "Unknown", Summary: UNKNOWN_SUMMARY, Hint: UNKNOWN_HINT, Detail: output };
  }
}
