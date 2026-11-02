import type { ToolchainHealth } from "@/common/rpc/types";

/** The first pin that is not installed, for the "Install SDK" action. */
export function RecommendedSdkVersion(health: ToolchainHealth): string {
  const candidates = [health.PinnedSdkVersion].filter(
    (version): version is string => Boolean(version)
  );
  return candidates.find(
    (version) => !health.InstalledSdks.some((sdk) => sdk.Version === version)
  ) ?? candidates[0] ?? "";
}
