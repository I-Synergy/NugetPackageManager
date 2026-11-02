import { hostApi } from "@/web/registrations";

/** Writes text to the clipboard; false when the browser refuses. */
export async function CopyTextAsync(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collects the toolchain report and copies it, returning the feedback line the
 * caller should show. One implementation for the banner, the tab, settings and
 * the actionable-error card.
 */
export async function CopyToolchainDiagnosticsAsync(
  projectPaths: string[],
  successMessage = "Diagnostics copied."
): Promise<string> {
  const result = await hostApi.runToolchainDiagnosticsAsync({ ProjectPaths: projectPaths });
  if (!result.ok) return "Could not collect diagnostics.";
  return (await CopyTextAsync(result.value.Report))
    ? successMessage
    : "Copy failed — see the output channel.";
}
