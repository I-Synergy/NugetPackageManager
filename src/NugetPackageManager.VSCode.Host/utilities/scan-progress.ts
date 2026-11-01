/**
 * Live progress for an in-flight `getOutdatedPackagesAsync` scan.
 *
 * The scan is a single RPC request, so the webview cannot observe it directly.
 * Callers that pass a `ScanId` with the request can poll this registry through
 * `getOutdatedScanProgressAsync` and render a determinate progress indicator
 * instead of an indefinite spinner.
 */

export type ScanProgressSnapshot = {
  Stage: string;
  Percent: number;
  Completed: number;
  Total: number;
};

type ScanEntry = ScanProgressSnapshot & { UpdatedAt: number };

const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 32;

const entries = new Map<string, ScanEntry>();

function pruneStaleEntries(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [scanId, entry] of entries) {
    if (entry.UpdatedAt < cutoff) entries.delete(scanId);
  }
  // Insertion order is update order for the common case; trim the oldest ids.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export class ScanProgress {
  public static Begin(scanId: string, stage: string): void {
    pruneStaleEntries();
    entries.delete(scanId);
    entries.set(scanId, { Stage: stage, Percent: 0, Completed: 0, Total: 0, UpdatedAt: Date.now() });
  }

  public static Report(
    scanId: string,
    stage: string,
    percent: number,
    completed = 0,
    total = 0
  ): void {
    const existing = entries.get(scanId);
    if (!existing) return;
    existing.Stage = stage;
    existing.Percent = clampPercent(percent);
    existing.Completed = Math.max(0, Math.floor(completed));
    existing.Total = Math.max(0, Math.floor(total));
    existing.UpdatedAt = Date.now();
  }

  public static Complete(scanId: string): void {
    entries.delete(scanId);
  }

  public static Get(scanId: string): ScanProgressSnapshot | null {
    const entry = entries.get(scanId);
    if (!entry) return null;
    if (entry.UpdatedAt < Date.now() - MAX_AGE_MS) {
      entries.delete(scanId);
      return null;
    }
    return {
      Stage: entry.Stage,
      Percent: entry.Percent,
      Completed: entry.Completed,
      Total: entry.Total,
    };
  }

  /** Test seam: drop every tracked scan. */
  public static Reset(): void {
    entries.clear();
  }
}
