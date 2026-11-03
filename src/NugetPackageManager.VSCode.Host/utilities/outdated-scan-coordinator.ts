import type { GetOutdatedPackagesResponse } from "@/common/rpc/types";
import { Logger } from "@/common/logger";
import { ScanProgress } from "./scan-progress";

/**
 * Module-level single-flight for `getOutdatedPackagesAsync`.
 *
 * The activity-bar badge, the packages view and the Updates tab all ask for the same scan at
 * activation. Without coordination each one runs the whole discovery + parse + feed walk again,
 * and on a large workspace the duplicates die on the per-request deadline together. One
 * {@link OutdatedScanCoordinator} for the whole extension collapses them into a single run whose
 * result every caller receives, and fans live progress out to every attached `ScanId`.
 *
 * The coordinator imports nothing from `host-api`: the scan itself is injected as `run`, so this
 * module stays free of the cycle `host-api` -> coordinator -> `host-api`.
 */

/** Writes live progress for one `ScanId`, matching `getOutdatedScanProgressAsync`. */
export type ScanReporter = (stage: string, percent: number, completed?: number, total?: number) => void;

export type OutdatedScanRun = {
  /** `BuildScanCacheKey(...)` result: identical scans share a key. */
  key: string;
  /** A forced scan never attaches to an in-flight run and never reads the memo. */
  forceReload: boolean;
  /** Every `ScanId` this caller wants progress for. */
  scanIds: string[];
  /** The scan body; `report` fans out, `signal` is the shared run's signal. */
  run: (report: ScanReporter, signal: AbortSignal) => Promise<GetOutdatedPackagesResponse>;
};

/** A caller that arrives this soon after a successful scan gets its result without a re-scan. */
const MEMO_WINDOW_MS = 5 * 60 * 1000;

const INITIAL_STAGE = "Resolving package sources…";

type MemoEntry = {
  response: GetOutdatedPackagesResponse;
  at: number;
};

type ProgressSnapshot = {
  stage: string;
  percent: number;
  completed: number;
  total: number;
};

type InFlightScan = {
  /** Identifies this generation; a forced run replaces the entry for the same key. */
  readonly generation: number;
  /** Mutable on purpose: a caller may attach (or detach) while the run is in flight. */
  readonly scanIds: Set<string>;
  /** Callers that ever attached, including ones detaching later: tells a join from a fresh run. */
  callers: number;
  readonly completion: Promise<GetOutdatedPackagesResponse>;
  /** Latest reported progress, so a late caller starts from the current stage, not from zero. */
  readonly latest: () => ProgressSnapshot;
};

type RunContext = {
  key: string;
  generation: number;
  controller: AbortController;
  scanIds: Set<string>;
  report: ScanReporter;
};

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("The outdated-package scan was cancelled.");
}

export class OutdatedScanCoordinator {
  private readonly inFlight = new Map<string, InFlightScan>();
  private readonly memo = new Map<string, MemoEntry>();
  private generation = 0;

  /**
   * Runs `run` unless an identical scan is already in flight or its result is memoized.
   *
   * `callerSignal` cancels only this caller: the shared run keeps going and its result still
   * reaches the callers that are still attached.
   */
  public RunAsync(
    run: OutdatedScanRun,
    callerSignal?: AbortSignal
  ): Promise<GetOutdatedPackagesResponse> {
    if (callerSignal?.aborted) {
      return Promise.reject(abortReason(callerSignal));
    }

    if (!run.forceReload) {
      const running = this.inFlight.get(run.key);
      if (running) {
        running.callers += 1;
        // An operator reading the log must be able to tell a real scan from a join.
        Logger.debug(`outdatedScans: attached to scan ${run.key} (${running.callers} callers)`);
        this.attachProgress(running, run.scanIds);
        return this.followAsync(running, run.scanIds, callerSignal);
      }

      const memoized = this.readMemo(run.key);
      if (memoized) return Promise.resolve(memoized);
    }

    return this.startAsync(run, callerSignal);
  }

  /** Test seam: forget every run and every memoized result. */
  public Reset(): void {
    this.inFlight.clear();
    this.memo.clear();
  }

  private startAsync(
    run: OutdatedScanRun,
    callerSignal: AbortSignal | undefined
  ): Promise<GetOutdatedPackagesResponse> {
    this.generation += 1;
    // Starting a generation discards the memo for that key, so a forced scan cannot be answered
    // from the result it was asked to replace.
    this.memo.delete(run.key);

    const controller = new AbortController();
    const scanIds = new Set(run.scanIds);
    let latest: ProgressSnapshot = { stage: INITIAL_STAGE, percent: 0, completed: 0, total: 0 };

    for (const scanId of scanIds) ScanProgress.Begin(scanId, latest.stage);

    const report: ScanReporter = (stage, percent, completed = 0, total = 0) => {
      latest = { stage, percent, completed, total };
      for (const scanId of scanIds) {
        ScanProgress.Report(scanId, stage, percent, completed, total);
      }
    };

    const context: RunContext = {
      key: run.key,
      generation: this.generation,
      controller,
      scanIds,
      report,
    };
    const completion = this.executeAsync(run, context);

    const entry: InFlightScan = {
      generation: context.generation,
      scanIds,
      callers: 1,
      completion,
      latest: () => latest,
    };
    this.inFlight.set(run.key, entry);
    Logger.debug(`outdatedScans: started scan ${run.key}`);

    return this.followAsync(entry, run.scanIds, callerSignal);
  }

  private async executeAsync(
    run: OutdatedScanRun,
    context: RunContext
  ): Promise<GetOutdatedPackagesResponse> {
    try {
      const response = await run.run(context.report, context.controller.signal);
      // Only the run that is still the current generation for this key may become the memo: an
      // older run finishing late must not overwrite a forced scan's fresher result.
      if (this.isCurrent(context)) {
        this.memo.set(context.key, { response, at: Date.now() });
      }
      return response;
    } finally {
      // A forced run may have replaced this generation; only clear the slot we still own.
      if (this.isCurrent(context)) {
        this.inFlight.delete(context.key);
      }
      for (const scanId of context.scanIds) ScanProgress.Complete(scanId);
      context.scanIds.clear();
    }
  }

  private isCurrent(context: RunContext): boolean {
    return this.inFlight.get(context.key)?.generation === context.generation;
  }

  /**
   * Registers `scanIds` for progress fan-out. An id that attaches mid-run is seeded with the
   * current stage so its indicator does not start from zero.
   */
  private attachProgress(entry: InFlightScan, scanIds: string[]): void {
    if (scanIds.length === 0) return;
    const current = entry.latest();
    for (const scanId of scanIds) {
      entry.scanIds.add(scanId);
      ScanProgress.Begin(scanId, current.stage);
      ScanProgress.Report(scanId, current.stage, current.percent, current.completed, current.total);
    }
  }

  /** Drops only this caller's `ScanId`s; the shared run keeps them out of its fan-out. */
  private detachProgress(entry: InFlightScan, scanIds: string[]): void {
    for (const scanId of scanIds) {
      entry.scanIds.delete(scanId);
      ScanProgress.Complete(scanId);
    }
  }

  private followAsync(
    entry: InFlightScan,
    scanIds: string[],
    callerSignal: AbortSignal | undefined
  ): Promise<GetOutdatedPackagesResponse> {
    if (!callerSignal) return entry.completion;

    const signal = callerSignal;
    return new Promise<GetOutdatedPackagesResponse>((resolve, reject) => {
      if (signal.aborted) {
        this.detachProgress(entry, scanIds);
        reject(abortReason(signal));
        return;
      }

      const onAbort = (): void => {
        this.detachProgress(entry, scanIds);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // Both outcomes are consumed here, so a detached caller never turns the shared run's
      // rejection into an unhandled one.
      entry.completion.then(
        (response) => {
          signal.removeEventListener("abort", onAbort);
          resolve(response);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  private readMemo(key: string): GetOutdatedPackagesResponse | null {
    const entry = this.memo.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > MEMO_WINDOW_MS) {
      this.memo.delete(key);
      return null;
    }
    return entry.response;
  }
}

/** One coordinator for the whole extension: every `createHostAPI()` caller shares it. */
export const outdatedScans = new OutdatedScanCoordinator();
