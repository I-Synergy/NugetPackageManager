import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";

import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "@/web/registrations";
import { buildFrameworkOptions, getFrameworkGroupKey, getFrameworkLabel, matchesFrameworkSelection, SHARED_FRAMEWORK, shouldShowFrameworkGroups } from "@/common/framework";
import { OutdatedPackageViewModel, PackageViewModel } from "../types";
import type { GetOutdatedPackagesRequest, GetOutdatedPackagesResponse, BatchUpdateRequest, BatchUpdateResponse, BatchUpdateConflict, DotnetFailureInfo } from "@/common/rpc/types";
import { RangeLowerBound } from "@/common/package-range";
import type { Result } from "@/common/rpc/result";
import { CANCELLED_ERROR, isCancelledMessage } from "@/common/rpc/result";
import { runBatchUpdateJobAsync, runOutdatedScanJobAsync } from "@/web/jobs";
import "./package-row";
import "./actionable-error";

type PlanLineKind = "direct" | "central" | "conditional" | "unresolved";

/** `net11.0 → 11.0.0-rc.3`, without a template inside a template. */
interface RequirementGroups {
  Central: Array<{ Id: string; Version: string }>;
  Mixed: Array<{ Id: string; ByTfm: Array<[string, string]> }>;
  Unresolved: string[];
}

/** Splits required versions into unconditional, per-TFM and unresolvable ones. */
function ClassifyRequirements(
  missing: Map<string, { Id: string; ByTfm: Map<string, string> }>
): RequirementGroups {
  const groups: RequirementGroups = { Central: [], Mixed: [], Unresolved: [] };
  for (const entry of missing.values()) {
    const versions = [...new Set(entry.ByTfm.values())];
    if (versions.length === 1 && versions[0] !== "unresolved") {
      groups.Central.push({ Id: entry.Id, Version: versions[0]! });
    } else if (versions.length > 1) {
      groups.Mixed.push({ Id: entry.Id, ByTfm: [...entry.ByTfm.entries()] });
    } else {
      groups.Unresolved.push(entry.Id);
    }
  }
  return groups;
}

/** Dependency step per package; a package nothing requires can go first. */
function BuildStepLookup(conflicts: BatchUpdateConflict[]): (id: string) => number {
  const orderByPackage = new Map<string, number>();
  for (const conflict of conflicts) {
    const id = conflict.BlockedByPackageId.toLowerCase();
    const current = orderByPackage.get(id);
    const next = conflict.Order ?? 0;
    orderByPackage.set(id, current === undefined ? next : Math.min(current, next));
  }
  return (id: string): number => orderByPackage.get(id.toLowerCase()) ?? 0;
}

function BuildPlanSteps(
  additions: OutdatedPackageViewModel[],
  requirements: RequirementGroups,
  stepOf: (id: string) => number
): Array<[number, Array<{ Text: string; Kind: PlanLineKind }>]> {
  const steps = new Map<number, Array<{ Text: string; Kind: PlanLineKind }>>();
  const addLine = (order: number, text: string, kind: PlanLineKind): void => {
    const existing = steps.get(order) ?? [];
    existing.push({ Text: text, Kind: kind });
    steps.set(order, existing);
  };

  for (const addition of additions) {
    addLine(stepOf(addition.Id), `${addition.Id} → ${addition.LatestVersion}`, "direct");
  }
  for (const entry of requirements.Central) {
    addLine(stepOf(entry.Id), `${entry.Id} → ${entry.Version}`, "central");
  }
  for (const entry of requirements.Mixed) {
    addLine(stepOf(entry.Id), `${entry.Id}: ${entry.ByTfm.map(FormatTfmVersion).join(", ")}`, "conditional");
  }
  for (const id of requirements.Unresolved) {
    addLine(0, `${id}: no resolvable version`, "unresolved");
  }

  return [...steps.entries()].sort((a, b) => a[0] - b[0]);
}

/** A package required at different versions per TFM becomes conditional groups. */
function BuildConditionalUpdates(
  mixed: RequirementGroups["Mixed"]
): Array<{ PackageId: string; Version: string; Condition: string }> {
  return mixed.flatMap((entry) =>
    entry.ByTfm
      .filter(([tfm]) => tfm !== "all")
      .map(([tfm, version]) => ({
        PackageId: entry.Id,
        Version: version,
        Condition: `'$(TargetFramework)' == '${tfm}'`,
      }))
  );
}

function FormatPlanText(orderedSteps: Array<[number, Array<{ Text: string; Kind: PlanLineKind }>]>): string[] {
  return [
    "Apply in this order (dependencies first):",
    ...orderedSteps.flatMap(([order, lines]) => [
      `Step ${order + 1}:`,
      ...lines.map((line) => `  [${line.Kind}] ${line.Text}`),
    ]),
    "",
  ];
}

function FormatTfmVersion(entry: readonly [string, string]): string {
  return `${entry[0]} → ${entry[1]}`;
}

/** Fallback when the host could not classify the failure. */
function ActionableFailure(message: string): DotnetFailureInfo {
  return {
    Kind: "Unknown",
    Summary: message,
    Hint: "Open the NuGet Package Manager output channel for the full command output.",
    Detail: "",
  };
}

@customElement("updates-view")
export class UpdatesView extends LitElement {
  static override readonly styles = [
    codicon,
    scrollableBase,
    sharedStyles,
    css`
      :host {
        display: block;
        flex: 1;
        width: 100%;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
      }

      .updates-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-height: 0;
        .outdated-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 5px 8px 0;
          padding: 10px 12px;
          border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
          border-radius: var(--npm-radius, 10px);
          background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
        }


          package-row {
            flex: 1;
            min-width: 0;
          }



          .row-actions {
            display: flex;
            align-items: center;
            flex-shrink: 0;
          }

          .package-list {
            flex: 0 0 auto;
          }

          .group-select {
            margin: 0;
            accent-color: var(--vscode-focusBorder);
          }

          .update-plan {
        margin: 6px 8px 0;
        padding: 8px 10px;
        border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
        border-left: 3px solid var(--vscode-focusBorder);
        border-radius: var(--npm-radius, 8px);
        background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .plan-header {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .plan-flag {
        color: var(--vscode-editorWarning-foreground);
        font-size: 0.9em;
      }

      .plan-spacer {
        flex: 1;
      }

      .plan-step {
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }

      .step-badge {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-badge-foreground);
        background: var(--vscode-badge-background);
      }

      .plan-step:first-of-type .step-badge {
        background: var(--vscode-focusBorder);
        color: var(--vscode-editor-background);
      }

      .step-lines {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .plan-line {
        display: flex;
        gap: 6px;
        align-items: baseline;
        overflow-wrap: anywhere;
      }

      .kind {
        flex: 0 0 auto;
        font-size: 0.78em;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        padding: 0 4px;
        border-radius: 6px;
        border: 1px solid currentColor;
      }

      .kind.direct {
        color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
      }

      .kind.central {
        color: var(--vscode-charts-green, var(--vscode-testing-iconPassed));
      }

      .kind.conditional {
        color: var(--vscode-editorWarning-foreground);
      }

      .kind.unresolved {
        color: var(--vscode-errorForeground);
      }

      .conflicts {
            margin: 6px 8px 10px;
            border: 1px solid var(--vscode-inputValidation-warningBorder, var(--npm-border, var(--vscode-panelSection-border)));
            border-radius: 8px;
            background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
          }

          .conflicts-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 7px 10px;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--npm-border, var(--vscode-panelSection-border));
          }

          .conflicts-list {
            list-style: none;
            margin: 0;
            padding: 0;
          }

          .conflict-row {
            display: flex;
            flex-direction: column;
            gap: 3px;
            padding: 8px 10px;
            font-size: 11px;
          }

          .conflict-row + .conflict-row {
            border-top: 1px solid color-mix(in srgb, var(--npm-border, var(--vscode-panelSection-border)) 60%, transparent);
          }

          .conflict-title {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 6px;
          }

          .conflict-id {
            font-weight: 600;
            color: var(--vscode-foreground);
          }

          .conflict-version,
          .conflict-reason {
            color: var(--vscode-descriptionForeground);
            line-height: 1.45;
          }

          .conflict-reason {
            font-family: var(--vscode-editor-font-family, monospace);
          }
        }

      }

      .loading-body {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        min-width: 220px;
        max-width: 360px;
      }

      .loading-stage {
        text-align: center;
        color: var(--vscode-descriptionForeground);
      }

      .loading-count {
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--vscode-descriptionForeground);
        opacity: 0.85;
      }

      .progress-track {
        width: 220px;
        height: 4px;
        border-radius: 2px;
        overflow: hidden;
        background: color-mix(in srgb, var(--vscode-progressBar-background) 30%, transparent);
      }

      .progress-fill {
        height: 100%;
        border-radius: 2px;
        background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
        transition: width 0.2s ease;
      }
    `,
  ];

  @state() packages: OutdatedPackageViewModel[] = [];
  @state() blockedPackages: Array<{
    Id: string;
    InstalledVersion: string;
    BlockedVersion: string;
    Reason: string;
    BlockedBy: Array<{ PackageId: string; InstalledVersion: string; Range: string }>;
  }> = [];
  @state() isRefreshing: boolean = false;
  @state() isUpdating: boolean = false;
  @state() statusText: string = "";
  /** Structured cause of the last failed update, if the host classified one. */
  @state() private failure: DotnetFailureInfo | undefined = undefined;
  /** Visible, colour-coded version of the preflight plan (survives the dialog). */
  @state() private updatePlan:
    | { Steps: Array<{ Order: number; Lines: Array<{ Text: string; Kind: PlanLineKind }> }>; Blocked: boolean }
    | null = null;
  @state() private failureHeading = "Update rolled back";
  /** Set when a plan dialog was already shown; avoids a second, redundant dialog. */
  private planDialogShown = false;
  @state() jobProgress: { Stage: string; Percent: number } | null = null;
  @state() scanProgress: {
    Stage: string;
    Percent: number;
    Completed: number;
    Total: number;
  } | null = null;
  @property() selectedFramework: string = "";
  @property({ type: Boolean }) prerelease: boolean = false;
  @property({ type: Boolean }) multiFramework: boolean = false;
  @property({ attribute: false }) projectPaths: string[] = [];
  @property() sourceUrl: string = "";
  @property() filterQuery: string = "";
  @property({ attribute: false }) availableFrameworks: Array<{ value: string; label: string }> = [];

  private _activeScanId: string = "";
  /**
   * The next run must bypass the host's cache.
   *
   * It travels through a field, not through the task's `args()`: `@lit/task` compares `args()`
   * against the arguments a run started with and aborts the in-flight run when they differ, so a
   * `forceReload` that lives in the args aborts every forced load on the next host update.
   */
  private _forceReloadNext = false;
  /**
   * Bumped by every successful update.
   *
   * A scan that was already in flight when the update landed holds the pre-update list; when it
   * comes back its result is discarded instead of repainted. The forced reload that follows the
   * `packages-updated` event repopulates the list.
   */
  private _mutationEpoch = 0;
  private _progressTimer: ReturnType<typeof setInterval> | undefined;
  private _progressPollInFlight = false;
  private _jobAbort: AbortController | undefined;
  private _jobId: string = "";

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._activeScanId = "";
    this.stopProgressPolling();
    // The host job keeps running (a deadline must not abort file writes); this
    // component just stops waiting for it.
    this._jobAbort?.abort();
    this._jobAbort = undefined;
  }

  private buildRequest(
    projectPaths: string[],
    sourceUrl: string,
    prerelease: boolean,
    forceReload: boolean,
    preferCache = false,
    scanId = ""
  ): GetOutdatedPackagesRequest {
    const req: GetOutdatedPackagesRequest = { Prerelease: prerelease };
    if (projectPaths.length > 0) req.ProjectPaths = projectPaths;
    if (sourceUrl) req.SourceUrl = sourceUrl;
    if (forceReload) req.ForceReload = true;
    if (preferCache) req.PreferCache = true;
    if (scanId) req.ScanId = scanId;
    return req;
  }

  private packageKey(pkg: OutdatedPackageViewModel): string {
    return `${pkg.Id}\0${pkg.CpmCondition}\0${pkg.CpmFramework}`;
  }

  private applyScan(response: GetOutdatedPackagesResponse, fromCache: boolean): void {
    const previousSelection = new Map<string, boolean>();
    for (const pkg of this.packages) {
      previousSelection.set(this.packageKey(pkg), pkg.Selected);
    }

    const packages = (response.Packages ?? []).map((pkg) => new OutdatedPackageViewModel(pkg));
    for (const pkg of packages) {
      pkg.Selected = previousSelection.get(this.packageKey(pkg)) ?? true;
    }

    this.packages = packages;
    this.blockedPackages = response.BlockedPackages ?? [];
    this.isRefreshing = fromCache;
    if (fromCache) {
      const scannedAt = response.ScannedAt ? new Date(response.ScannedAt).toLocaleTimeString() : "";
      this.statusText = scannedAt
        ? `Showing cached results from ${scannedAt} — refreshing…`
        : "Refreshing…";
    } else {
      this.statusText = "";
    }

    this.dispatchEvent(new CustomEvent<number>("count-changed", {
      detail: packages.length,
      bubbles: true,
      composed: true,
    }));
    this.dispatchEvent(new CustomEvent<{ Count: number; BlockedCount: number }>("badge-changed", {
      detail: { Count: packages.length, BlockedCount: this.blockedPackages.length },
      bubbles: true,
      composed: true,
    }));
    this.dispatchEvent(new CustomEvent("framework-options-changed", {
      detail: this.frameworkOptions,
      bubbles: true,
      composed: true,
    }));
  }

  private startProgressPolling(scanId: string): void {
    this.stopProgressPolling();
    this._progressTimer = setInterval(() => {
      void this.refreshScanProgressAsync(scanId);
    }, 400);
  }

  private stopProgressPolling(): void {
    if (this._progressTimer !== undefined) {
      clearInterval(this._progressTimer);
      this._progressTimer = undefined;
    }
  }

  private async refreshScanProgressAsync(scanId: string): Promise<void> {
    if (this._activeScanId !== scanId || this._progressPollInFlight) return;
    this._progressPollInFlight = true;
    try {
      const result = await hostApi.getOutdatedScanProgressAsync({ ScanId: scanId });
      if (this._activeScanId !== scanId) return;
      if (!result.ok || !result.value.Active) return;
      this.scanProgress = {
        Stage: result.value.Stage,
        Percent: result.value.Percent,
        Completed: result.value.Completed,
        Total: result.value.Total,
      };
    } finally {
      this._progressPollInFlight = false;
    }
  }

  /**
   * Runs a batch update as a host job and waits for its terminal response.
   *
   * The transaction is a snapshot/write/restore over the whole repo, so its
   * runtime must not be bounded by the RPC deadline; the job id also lets the
   * tab render real progress.
   */
  private async updateAsJobAsync(request: BatchUpdateRequest): Promise<Result<BatchUpdateResponse>> {
    const abort = new AbortController();
    this._jobAbort = abort;
    this.jobProgress = { Stage: "Starting update…", Percent: 0 };
    try {
      return await runBatchUpdateJobAsync(request, {
        signal: abort.signal,
        onStarted: (jobId) => {
          this._jobId = jobId;
        },
        onProgress: (progress) => {
          this.jobProgress = progress;
        },
      });
    } finally {
      if (this._jobAbort === abort) this._jobAbort = undefined;
      this._jobId = "";
      this.jobProgress = null;
    }
  }

  /** Explicitly aborts the running transaction; the host rolls back its writes. */
  private async cancelJobAsync(): Promise<void> {
    if (!this._jobId) return;
    this.statusText = "Cancelling update…";
    const result = await hostApi.cancelJobAsync({ JobId: this._jobId });
    if (!result.ok) {
      this.statusText = `Failed to cancel: ${result.error}`;
    }
  }

  private readonly _loadTask = new Task(this, {

    task: async ([projectPaths, sourceUrl, prerelease], { signal }) => {
      // Read and clear before the first await: a re-render during this run must not reset it for
      // the run that is already in flight.
      const forceReload = this._forceReloadNext;
      this._forceReloadNext = false;
      const epoch = this._mutationEpoch;
      const scanId = globalThis.crypto.randomUUID();
      this._activeScanId = scanId;
      this.scanProgress = {
        Stage: "Preparing update check…",
        Percent: 0,
        Completed: 0,
        Total: 0,
      };
      this.startProgressPolling(scanId);
      try {
        // The scan runs as a host job: a cold parse of a large repository (and the feed walk that
        // follows) outgrows the RPC deadline, and a client deadline must never turn a healthy scan
        // into "Failed to check for updates". `signal` only stops this view waiting.
        const result = await runOutdatedScanJobAsync(
          this.buildRequest(projectPaths, sourceUrl, prerelease, forceReload, false, scanId),
          {
            signal,
            // The job's stage/percent feed the same banner the `ScanId` polling fills; the polling
            // keeps the finer counts, so one banner is written, never two copies of the text.
            onProgress: (progress) => {
              if (this._activeScanId !== scanId) return;
              this.scanProgress = {
                Stage: progress.Stage,
                Percent: progress.Percent,
                Completed: this.scanProgress?.Completed ?? 0,
                Total: this.scanProgress?.Total ?? 0,
              };
            },
          }
        );
        if (!result.ok) {
          // A superseded run, a closed view or a cancelled job is not a scan failure: the host
          // keeps scanning, and the next run paints its result.
          if (isCancelledMessage(result.error)) throw new Error(CANCELLED_ERROR);
          throw new Error(result.error);
        }
        // An update landed while this scan was running, so what it found describes the workspace
        // as it was before the write. Publish nothing: the forced reload repopulates the list.
        if (epoch !== this._mutationEpoch) {
            const discarded: GetOutdatedPackagesResponse = { Packages: [] };
            return discarded;
        }
        return result.value;
      } finally {
        if (this._activeScanId === scanId) {
          this._activeScanId = "";
          this.stopProgressPolling();
          this.scanProgress = null;
          this.dispatchEvent(new CustomEvent("scan-finished", { bubbles: true, composed: true }));
        }
      }
    },
    args: () => [this.projectPaths, this.sourceUrl, this.prerelease] as [string[], string, boolean],
    onComplete: (response) => {
      this.applyScan(response, false);
    },
    onError: () => {
      this.isRefreshing = false;
    },
  });

  get frameworkOptions(): Array<{ value: string; label: string }> {
    const values = [
      ...this.packages.map((pkg) => pkg.CpmFramework),
      ...this.availableFrameworks.map((option) => option.value),
    ];
    return buildFrameworkOptions(values, this.packages.some((pkg) => pkg.CpmFramework === ""));
  }

  private get visiblePackages(): OutdatedPackageViewModel[] {
    let list = this.packages;
    if (this.selectedFramework !== "" && this.frameworkOptions.length > 0) {
      list = list.filter((pkg) =>
        matchesFrameworkSelection(this.selectedFramework, pkg.CpmFramework)
      );
    }
    if (!this.filterQuery) return list;
    const q = this.filterQuery.toLowerCase();
    return list.filter((p) => p.Id.toLowerCase().includes(q));
  }

  private get groupedVisiblePackages(): Array<{ key: string; label: string; packages: OutdatedPackageViewModel[] }> {
    const groups = new Map<string, OutdatedPackageViewModel[]>();
    for (const pkg of this.visiblePackages) {
      const key = getFrameworkGroupKey(this.selectedFramework, pkg.CpmFramework);
      const list = groups.get(key) ?? [];
      list.push(pkg);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([key, packages]) => ({
        key,
        label: key ? getFrameworkLabel(key) : getFrameworkLabel(SHARED_FRAMEWORK),
        packages,
      }))
      .sort((a, b) => {
        if (a.key === "" && b.key !== "") return -1;
        if (a.key !== "" && b.key === "") return 1;
        return a.key.localeCompare(b.key);
      });
  }

  private get hasMultipleTfmsSelected(): boolean {
    const counts = new Map<string, number>();
    for (const pkg of this.visiblePackages) {
      if (!pkg.Selected || pkg.CpmFramework === "") continue;
      counts.set(pkg.Id, (counts.get(pkg.Id) ?? 0) + 1);
    }
    return [...counts.values()].some((count) => count > 1);
  }

  private async updateAllSelectedAsync(): Promise<void> {
    const selected = this.visiblePackages.filter((pkg) => pkg.Selected && !pkg.IsUpdating);
    if (selected.length === 0) return;

    const confirm = await hostApi.showConfirmationAsync({
      Message: `Update ${selected.length} package${selected.length !== 1 ? "s" : ""}?`,
      Detail: selected.map((pkg) => `${pkg.Id}: ${pkg.InstalledVersion} -> ${pkg.LatestVersion}`).join("\n"),
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    await this.updatePackagesSequentiallyAsync(selected);
  }

  private async updateAllTfmsAsync(): Promise<void> {
    const selectedIds = new Set(
      this.visiblePackages.filter((pkg) => pkg.Selected).map((pkg) => pkg.Id)
    );
    const targets = this.packages.filter(
      (pkg) => selectedIds.has(pkg.Id) && pkg.CpmFramework !== "" && !pkg.IsUpdating
    );
    if (targets.length === 0) return;

    const confirm = await hostApi.showConfirmationAsync({
      Message: `Update ${targets.length} framework-scoped package version${targets.length !== 1 ? "s" : ""}?`,
      Detail: targets
        .map((pkg) => `${pkg.Id} [${pkg.CpmFramework}]: ${pkg.InstalledVersion} -> ${pkg.LatestVersion}`)
        .join("\n"),
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    await this.updatePackagesSequentiallyAsync(targets);
  }

  private get allVisibleSelected(): boolean {
    const visible = this.visiblePackages;
    return visible.length > 0 && visible.every((p) => p.Selected);
  }

  private toggleSelectAll(): void {
    const selectAll = !this.allVisibleSelected;
    this.visiblePackages.forEach((p) => { p.Selected = selectAll; });
    this.requestUpdate();
  }

  private toggleGroupSelection(packages: OutdatedPackageViewModel[], selected: boolean): void {
    packages.forEach((pkg) => { pkg.Selected = selected; });
    this.requestUpdate();
  }

  async LoadOutdatedPackagesAsync(forceReload: boolean = false): Promise<void> {
    this.packages = [];
    this.blockedPackages = [];
    this.isRefreshing = false;
    this.statusText = "";

    // Paint the previous scan immediately, then refresh in the background. The
    // cache is best-effort: a miss or failure must never block the live scan.
    if (!forceReload) {
      try {
        const cached = await hostApi.getOutdatedPackagesAsync(
          this.buildRequest(this.projectPaths, this.sourceUrl, this.prerelease, false, true)
        );
        if (cached.ok && ((cached.value.Packages?.length ?? 0) > 0 || (cached.value.BlockedPackages?.length ?? 0) > 0)) {
          this.applyScan(cached.value, true);
        }
      } catch (err) {
        console.debug("UpdatesView: cached scan unavailable", err);
      }
    }

    try {
      this._forceReloadNext = forceReload;
      await this._loadTask.run();
    } catch (err) {
      this.isRefreshing = false;
      if (this.packages.length > 0) {
        this.statusText = "Showing cached results — refresh failed";
      }
      console.error(err);
    }
  }

  private async updateSingleAsync(
    pkg: OutdatedPackageViewModel,
    skipRestore = false,
    version = pkg.LatestVersion
  ): Promise<boolean> {
    if (this.isRefreshing) return false;
    pkg.IsUpdating = true;
    this.requestUpdate();
    try {
      const result = await this.updateAsJobAsync({
        // The host runs the whole transaction as a background job: snapshot,
        // write, restore and roll back if restore fails.
        SkipRestore: skipRestore,
        Transactional: true,
        Updates: [this.toUpdateRequestFor(pkg, version)],
      });
      if (result.ok && result.value.Cancelled) {
        this.statusText = "Update cancelled — the versions already written were rolled back";
        return false;
      }
      const succeeded = result.ok && !result.value.RolledBack && result.value.Results.every((r) => r.Success);
      if (!succeeded) {
        this.setSingleFailureStatus(pkg, result);
        return false;
      }
      await this.handleSingleSuccessAsync(pkg, version);
      return true;
    } finally {
      pkg.IsUpdating = false;
      this.requestUpdate();
    }
  }

  private toUpdateRequestFor(
    pkg: OutdatedPackageViewModel,
    version: string
  ): BatchUpdateRequest["Updates"][number] {
    return {
      PackageId: pkg.Id,
      Version: version,
      ProjectPaths: pkg.Projects.map((p) => p.Path),
      ...(pkg.CpmCondition ? { CpmCondition: pkg.CpmCondition } : {}),
      ...(pkg.CpmFramework ? { CpmTfm: pkg.CpmFramework } : {}),
      Scope: pkg.CpmCondition ? "group" : "unconditional",
    };
  }

  private async handleSingleSuccessAsync(pkg: OutdatedPackageViewModel, version: string): Promise<void> {
    // Bumped before `packages-updated`: a scan still in flight from before the write must not
    // paint the pre-update list when it lands.
    this._mutationEpoch += 1;
    // Condition + TFM identify a framework-scoped row, so updating the net10.0
    // line does not also remove the net11.0 entry.
    this.packages = this.packages.filter(
      (p) => !(p.Id === pkg.Id && p.CpmCondition === pkg.CpmCondition && p.CpmFramework === pkg.CpmFramework)
    );
    this.dispatchEvent(new CustomEvent<number>("count-changed", {
      detail: this.packages.length,
      bubbles: true,
      composed: true,
    }));
    // The header already renders "<n> updates available"; the suffix says what changed.
    this.statusText = `Updated ${pkg.Id} to ${version}`;
    await hostApi.updateBadgeAsync({
      Count: this.packages.length,
      BlockedCount: this.blockedPackages.length,
    });
    this.dispatchEvent(new CustomEvent("packages-updated", { bubbles: true, composed: true }));
  }

  private setSingleFailureStatus(
    pkg: OutdatedPackageViewModel,
    result: Result<BatchUpdateResponse>
  ): void {
    const error = result.ok
      ? (result.value.RestoreError ?? result.value.RollbackError ?? result.value.Results.find((r) => !r.Success)?.Error)
      : result.error;
    const fallback = error ? ActionableFailure(error) : undefined;
    this.failure = result.ok ? (result.value.Failure ?? fallback) : ActionableFailure(result.error);
    this.failureHeading = result.ok && result.value.RolledBack ? "Update rolled back" : "Update failed";
    const errorSuffix = error ? `: ${error}` : "";
    this.statusText = result.ok && result.value.RolledBack
      ? `Update rolled back${errorSuffix}`
      : `Failed to update ${pkg.Id}${errorSuffix}`;
  }

  private toUpdateRequest(pkg: OutdatedPackageViewModel): BatchUpdateRequest["Updates"][number] {
    return {
      PackageId: pkg.Id,
      Version: pkg.LatestVersion,
      ProjectPaths: pkg.Projects.map((project) => project.Path),
      ...(pkg.CpmCondition ? { CpmCondition: pkg.CpmCondition } : {}),
      ...(pkg.CpmFramework ? { CpmTfm: pkg.CpmFramework } : {}),
      Scope: pkg.CpmCondition ? "group" : "unconditional",
    };
  }

  /**
   * Checks the whole selection against the dependency graph before anything is
   * written. Conflicting rows are dropped only with the user's confirmation, so
   * one bad package cannot cost the rest of the batch.
   */
  private async preflightAsync(
    packages: OutdatedPackageViewModel[],
    expansionDepth = 2
  ): Promise<OutdatedPackageViewModel[]> {
    const check = await hostApi.checkBatchUpdateAsync({
      Updates: packages.map((pkg) => this.toUpdateRequest(pkg)),
      Transactional: true,
      SkipRestore: false,
    });
    if (!check.ok || check.value.Conflicts.length === 0) {
      this.updatePlan = null;
      return packages;
    }

    const conflicting = new Set(
      check.value.Conflicts.map((conflict) => `${conflict.PackageId.toLowerCase()}@${conflict.RequestedVersion}`)
    );
    const remaining = packages.filter(
      (pkg) => !conflicting.has(`${pkg.Id.toLowerCase()}@${pkg.LatestVersion}`)
    );
    // When the selection cannot be trimmed (nothing, or everything, conflicts),
    // try completing it with the packages the conflicts ask for instead.
    if (remaining.length === 0 || remaining.length === packages.length) {
      const expanded = await this.tryExpandSelectionAsync(
        check.value.Conflicts,
        packages,
        expansionDepth
      );
      if (expanded) return expanded;
    }

    if (remaining.length === packages.length) return packages;

    if (remaining.length === 0) {
      if (this.planDialogShown) {
        this.planDialogShown = false;
        this.statusText =
          "Update cancelled before writing — mixed target frameworks need conditional central versions";
        return [];
      }
      const detail = check.value.Conflicts
        .slice(0, 8)
        .map((conflict) => `${conflict.PackageId} → ${conflict.RequestedVersion}: ${conflict.Reason}`);
      if (check.value.Conflicts.length > 8) {
        detail.push(`…and ${check.value.Conflicts.length - 8} more`);
      }
      await hostApi.showConfirmationAsync({
        Message: "No updates can be applied: every selected version conflicts with the dependency graph.",
        Detail: `${detail.join("\n")}\n\nInclude the packages these versions require and try again.`,
      });
      this.statusText = "Update cancelled before writing — the selection cannot be applied without its required packages";
      return [];
    }

    const detail = check.value.Conflicts
      .slice(0, 8)
      .map((conflict) => `${conflict.PackageId} → ${conflict.RequestedVersion}: ${conflict.Reason}`);
    if (check.value.Conflicts.length > 8) {
      detail.push(`…and ${check.value.Conflicts.length - 8} more`);
    }

    const confirm = await hostApi.showConfirmationAsync({
      Message: `${packages.length - remaining.length} of ${packages.length} updates conflict with the dependency graph.`,
      Detail: `${detail.join("\n")}\n\nUpdate the other ${remaining.length} package${remaining.length !== 1 ? "s" : ""}?`,
    });
    if (!confirm.ok || !confirm.value.Confirmed) {
      this.statusText = "Update cancelled before writing — the selection contains dependency conflicts";
      return [];
    }

    this.statusText = `Skipping ${packages.length - remaining.length} conflicting update${packages.length - remaining.length !== 1 ? "s" : ""}`;
    return remaining;
  }

  /** Selected packages the conflicts ask for, with the exact required version. */
  /**
   * Requirements a conflict asks for, grouped per package and target framework.
   *
   * The same package can be required at different versions per TFM (the preview
   * set ships one dependency group per target framework), and a single
   * unconditional `PackageVersion` cannot satisfy both.
   */
  private collectRequiredUpdates(
    conflicts: BatchUpdateConflict[],
    selected: OutdatedPackageViewModel[]
  ): {
    additions: OutdatedPackageViewModel[];
    missing: Map<string, { Id: string; ByTfm: Map<string, string> }>;
  } {
    const selectedIds = new Set(selected.map((pkg) => pkg.Id.toLowerCase()));
    const byId = new Map(this.packages.map((pkg) => [pkg.Id.toLowerCase(), pkg]));
    const additions: OutdatedPackageViewModel[] = [];
    const missing = new Map<string, { Id: string; ByTfm: Map<string, string> }>();

    for (const conflict of conflicts) {
      const dependencyId = conflict.BlockedByPackageId.toLowerCase();
      if (selectedIds.has(dependencyId)) continue;

      const version = conflict.RequiredVersion ?? RangeLowerBound(conflict.RequiredRange);
      const row = byId.get(dependencyId);
      if (!row || !version) {
        const entry = missing.get(dependencyId) ?? { Id: conflict.BlockedByPackageId, ByTfm: new Map<string, string>() };
        entry.ByTfm.set(conflict.Tfm ?? "all", version ?? "unresolved");
        missing.set(dependencyId, entry);
        continue;
      }
      if (!additions.some((candidate) => candidate.Id.toLowerCase() === dependencyId)) {
        additions.push(
          row.LatestVersion === version
            ? row
            : new OutdatedPackageViewModel({ ...row, LatestVersion: version })
        );
      }
    }

    return { additions, missing };
  }

  /**
   * Preview framework sets must move together: when every selected version needs
   * newer siblings, offer to include those siblings at the required version and
   * re-run the preflight instead of dead-ending.
   */
  private async tryExpandSelectionAsync(
    conflicts: BatchUpdateConflict[],
    packages: OutdatedPackageViewModel[],
    depth: number
  ): Promise<OutdatedPackageViewModel[] | null> {
    if (depth <= 0) return null;

    const { additions, missing } = this.collectRequiredUpdates(conflicts, packages);
    const requirements = ClassifyRequirements(missing);
    const orderedSteps = BuildPlanSteps(additions, requirements, BuildStepLookup(conflicts));
    const conditionalUpdates = BuildConditionalUpdates(requirements.Mixed);

    this.updatePlan = {
      Blocked: requirements.Unresolved.length > 0,
      Steps: orderedSteps.map(([order, lines]) => ({ Order: order, Lines: lines })),
    };
    const planLines = FormatPlanText(orderedSteps);

    const nothingToApply =
      additions.length === 0 &&
      requirements.Central.length === 0 &&
      conditionalUpdates.length === 0;
    if (requirements.Unresolved.length > 0 || nothingToApply) {
      this.planDialogShown = true;
      await hostApi.showConfirmationAsync({
        Message: `${conflicts.length} conflict(s) cannot be resolved automatically — nothing was changed.`,
        Detail: [
          "The selection cannot be applied as one update. Required changes:",
          "",
          ...planLines,
          "Apply them (or align the target frameworks) and update again.",
        ].join("\n"),
      });
      this.statusText = "Update cancelled before writing — the dialog lists the required changes";
      return null;
    }

    const include = await hostApi.showConfirmationAsync({
      Message: `${conflicts.length} conflict(s) — apply the required changes and continue?`,
      Detail: [...planLines, "Continue?"].join("\n"),
    });
    if (!include.ok || !include.value.Confirmed) {
      this.planDialogShown = true;
      return null;
    }

    if (requirements.Central.length > 0 || conditionalUpdates.length > 0) {
      const raised = await this.raiseCentralVersionsAsync(requirements.Central, conditionalUpdates);
      if (raised === null) return null;
      if (raised === 0 && additions.length === 0) return null;
    }

    if (additions.length > 0) {
      this.statusText = `Including ${additions.length} required update${additions.length === 1 ? "" : "s"}…`;
    }
    return await this.preflightAsync([...packages, ...additions], depth - 1);
  }

  /** Writes central raises and reports how many entries were applied, or `null` on failure. */
  private async raiseCentralVersionsAsync(
    central: Array<{ Id: string; Version: string }>,
    conditional: Array<{ PackageId: string; Version: string; Condition: string }>
  ): Promise<number | null> {
    const raised = await hostApi.updateCentralVersionsAsync({
      ProjectPaths: this.projectPaths,
      Updates: [
        ...central.map((entry) => ({ PackageId: entry.Id, Version: entry.Version })),
        ...conditional,
      ],
    });
    if (!raised.ok) {
      this.statusText = `Could not raise central versions: ${raised.error}`;
      return null;
    }

    const applied = raised.value.Applied.length;
    const versionWord = applied === 1 ? "version" : "versions";
    const skippedNote =
      raised.value.Skipped.length > 0
        ? ` (${raised.value.Skipped.length} not found in Directory.Packages.props)`
        : "";
    this.statusText = `Raised ${applied} central ${versionWord}${skippedNote}`;
    return applied;
  }

  private async updatePackagesSequentiallyAsync(
    packages: OutdatedPackageViewModel[]
  ): Promise<void> {
    if (packages.length === 0 || this.isRefreshing) return;

    this.isUpdating = true;
    packages.forEach((pkg) => { pkg.IsUpdating = true; });
    this.requestUpdate();
    try {
      const remaining = await this.preflightAsync(packages);
      if (remaining.length === 0) return;
      await this.runSelectedUpdatesAsync(remaining, true);
    } finally {
      packages.forEach((pkg) => { pkg.IsUpdating = false; });
      this.isUpdating = false;
      this.requestUpdate();
    }
  }

  private async runSelectedUpdatesAsync(
    packages: OutdatedPackageViewModel[],
    allowRetry: boolean
  ): Promise<void> {
    if (packages.length === 0) return;

    const packageWord = packages.length === 1 ? "package" : "packages";
    this.statusText = `Updating ${packages.length} ${packageWord} transactionally...`;
    this.failure = undefined;
    this.requestUpdate();

    const result = await this.updateAsJobAsync({
      Updates: packages.map((pkg) => this.toUpdateRequest(pkg)),
      Transactional: true,
      SkipRestore: false,
    });

    if (!result.ok) {
      this.statusText = `Update failed: ${result.error}`;
      this.failure = ActionableFailure(result.error);
      this.failureHeading = "Update failed";
      return;
    }
    if (result.value.Cancelled) {
      this.statusText = "Update cancelled — the versions already written were rolled back";
      return;
    }
    if (result.value.RolledBack) {
      await this.handleSelectedRollbackAsync(packages, allowRetry, result.value);
      return;
    }

    await this.handleSelectedSuccessAsync(packages);
  }

  private async handleSelectedRollbackAsync(
    packages: OutdatedPackageViewModel[],
    allowRetry: boolean,
    response: BatchUpdateResponse
  ): Promise<void> {
    const reason = response.RestoreError ?? response.RollbackError;
    this.failure = response.Failure ?? (reason ? ActionableFailure(reason) : undefined);
    this.failureHeading = "Update rolled back";
    const reasonSuffix = reason ? `: ${reason}` : "";
    this.statusText = `Update rolled back${reasonSuffix}`;
    await hostApi.updateBadgeAsync({
      Count: this.packages.length,
      BlockedCount: this.blockedPackages.length,
    });

    const culprits = response.ConflictingPackages ?? [];
    const culpritIds = new Set(culprits.map((id) => id.toLowerCase()));
    const retryable = packages.filter((pkg) => !culpritIds.has(pkg.Id.toLowerCase()));
    if (!allowRetry || culprits.length === 0 || retryable.length === 0) return;

    const culpritWord = culprits.length === 1 ? "package" : "packages";
    const confirm = await hostApi.showConfirmationAsync({
      Message: `Retry without ${culprits.length} ${culpritWord} the failed restore points at?`,
      Detail: `${culprits.join(", ")}\n\n${reason ?? ""}`,
    });
    if (confirm.ok && confirm.value.Confirmed) {
      await this.runSelectedUpdatesAsync(retryable, false);
    }
  }

  private async handleSelectedSuccessAsync(packages: OutdatedPackageViewModel[]): Promise<void> {
    // See `handleSingleSuccessAsync`: any scan in flight predates this write.
    this._mutationEpoch += 1;
    // The transaction succeeded, so every selected row can be removed.
    this.packages = this.packages.filter((pkg) => !packages.includes(pkg));
    this.dispatchEvent(new CustomEvent<number>("count-changed", {
      detail: this.packages.length,
      bubbles: true,
      composed: true,
    }));
    const packageWord = packages.length === 1 ? "package" : "packages";
    this.statusText = `${packages.length} ${packageWord} updated and restored`;
    this.failure = undefined;
    await hostApi.updateBadgeAsync({
      Count: this.packages.length,
      BlockedCount: this.blockedPackages.length,
    });
    this.dispatchEvent(new CustomEvent("packages-updated", { bubbles: true, composed: true }));
  }


  private toPackageViewModel(pkg: OutdatedPackageViewModel): PackageViewModel {
    // The scan already knows the popularity metadata, so the row does not need a refetch.
    const vm = PackageViewModel.Empty(pkg.Id, "Detailed");
    vm.Version = pkg.LatestVersion;
    vm.InstalledVersion = pkg.InstalledVersion;
    vm.TotalDownloads = pkg.TotalDownloads;
    vm.Verified = pkg.Verified;
    vm.CpmFramework = pkg.CpmFramework;
    return vm;
  }

  private renderPackageRow(pkg: OutdatedPackageViewModel): unknown {
    const checkbox = pkg.IsUpdating
      ? html`<span class="spinner medium row-checkbox" role="status" aria-label="Updating ${pkg.Id}"></span>`
      : html`
          <input
            class="row-checkbox"
            type="checkbox"
            aria-label="Select ${pkg.Id} for update"
            .checked=${pkg.Selected}
            @change=${(e: Event) => {
              pkg.Selected = (e.target as HTMLInputElement).checked;
              this.requestUpdate();
            }}
          />
        `;

    const unmatchedBadge = pkg.CpmMatched
      ? nothing
      : html`<span class="codicon codicon-warning" title="This condition matches none of the project's target frameworks"></span>`;

    const blockedBadge = pkg.BlockedBy.length > 0
      ? html`<span
          class="codicon codicon-lock"
          title="Latest ${pkg.LatestOverallVersion} is blocked by ${pkg.blockedReason}. Suggested version stays at ${pkg.LatestVersion}."
        ></span>`
      : nothing;

    const latestOverallTitle = pkg.BlockedBy.length > 0
      ? `Update ${pkg.Id} to ${pkg.LatestOverallVersion}, overriding ${pkg.blockedReason}. Restore may fail.`
      : `Update ${pkg.Id} to latest overall ${pkg.LatestOverallVersion}`;

    const latestOverallButton = pkg.LatestOverallVersion
      ? html`
          <button
            class="icon-btn"
            aria-label="Update ${pkg.Id} to latest overall ${pkg.LatestOverallVersion}"
            title=${latestOverallTitle}
            ?disabled=${this.isUpdating || this.isRefreshing || pkg.IsUpdating}
            @click=${async () => await this.updateSingleAsync(pkg, false, pkg.LatestOverallVersion)}
          >
            <span class="codicon codicon-arrow-up"></span>
          </button>
        `
      : nothing;

    return html`
      <div class="outdated-row">
        ${checkbox}
        <package-row
          .package=${this.toPackageViewModel(pkg)}
          .embedded=${true}
          .updateVersion=${pkg.LatestVersion}
          @click=${() => this.dispatchEvent(new CustomEvent("package-selected", {
            detail: { packageId: pkg.Id, sourceUrl: pkg.SourceUrl },
            bubbles: true,
            composed: true,
          }))}
        ></package-row>
        ${unmatchedBadge}
        ${blockedBadge}
        <div class="row-actions">
          ${latestOverallButton}
          <button class="icon-btn" aria-label="Update ${pkg.Id}" title="Update ${pkg.Id}" ?disabled=${this.isUpdating || this.isRefreshing || pkg.IsUpdating} @click=${async () => await this.updateSingleAsync(pkg)}>
            <span class="codicon codicon-arrow-circle-up"></span>
          </button>
        </div>
      </div>
    `;
  }

  private renderHeaderActions(): unknown {
    if (this.visiblePackages.length === 0) return nothing;

    const totalSelectedCount = this.visiblePackages.filter((p) => p.Selected).length;
    const selectAllLabel = this.allVisibleSelected ? "Deselect all" : "Select all";
    const updateBtnLabel = this.allVisibleSelected
      ? `Update all (${totalSelectedCount})`
      : `Update selected (${totalSelectedCount})`;
    const multipleTfmButton = this.hasMultipleTfmsSelected
      ? html`
          <button
            class="secondary-btn"
            ?disabled=${this.isUpdating || this.isRefreshing}
            title="Update every selected package for all of its target frameworks"
            @click=${async () => await this.updateAllTfmsAsync()}
          >
            Update all TFMs
          </button>
        `
      : nothing;

    return html`
      <button class="ghost-btn" title="${selectAllLabel}" @click=${() => this.toggleSelectAll()}>
        ${selectAllLabel}
      </button>
      <button class="primary-btn" ?disabled=${this.isUpdating || this.isRefreshing || totalSelectedCount === 0} @click=${async () => await this.updateAllSelectedAsync()}>
        ${updateBtnLabel}
      </button>
      ${multipleTfmButton}
    `;
  }

  private renderStatusSuffix(): unknown {
    return this.statusText ? html` · ${this.statusText}` : nothing;
  }

  private renderUpdatePlan(): unknown {
    const plan = this.updatePlan;
    if (!plan || plan.Steps.length === 0) return nothing;

    const steps = [...plan.Steps].sort((a, b) => a.Order - b.Order);
    const stepWord = steps.length === 1 ? "step" : "steps";

    return html`
      <div class="update-plan">
        <div class="plan-header">
          <span class="codicon codicon-list-ordered"></span>
          <b>Update plan — ${steps.length} ${stepWord}</b>
          ${plan.Blocked
            ? html`<span class="plan-flag">needs manual changes</span>`
            : nothing}
          <span class="plan-spacer"></span>
          <button class="ghost-btn" @click=${() => { this.updatePlan = null; }}>Dismiss</button>
        </div>
        ${steps.map(
          (step) => html`
            <div class="plan-step">
              <span class="step-badge" aria-label="Step ${step.Order + 1}">${step.Order + 1}</span>
              <div class="step-lines">
                ${step.Lines.map(
                  (line) => html`
                    <div class="plan-line">
                      <span class="kind ${line.Kind}">${line.Kind}</span>
                      <span>${line.Text}</span>
                    </div>
                  `
                )}
              </div>
            </div>
          `
        )}
        ${plan.Blocked
          ? html`<div class="empty-hint">Nothing was written. Apply the steps above (dependencies first) and check for updates again.</div>`
          : nothing}
      </div>
    `;
  }

  private renderInfoBanner(): unknown {
    if (!this.multiFramework || this.visiblePackages.length === 0) return nothing;
    return html`<div class="info-banner">
      <span class="codicon codicon-info"></span>
      <span>Framework-aligned packages stay on the target framework's major line; crossing it in a multi-.NET-major workspace requires the "allow major version override" setting.</span>
    </div>`;
  }

  private renderConflicts(): unknown {
    if (this.blockedPackages.length === 0) return nothing;
    return html`<section class="conflicts" aria-label="Dependency conflicts">
      <div class="conflicts-header">
        <span class="codicon codicon-lock"></span>
        <span>Dependency conflicts (${this.blockedPackages.length})</span>
      </div>
      <ul class="conflicts-list">
        ${this.blockedPackages.map((blocked) => html`
          <li class="conflict-row">
            <span class="conflict-title">
              <span class="conflict-id">${blocked.Id}</span>
              <span class="conflict-version">
                ${blocked.InstalledVersion} → ${blocked.BlockedVersion} blocked
              </span>
            </span>
            <span class="conflict-reason">
              blocked by ${blocked.BlockedBy.map((constraint) =>
                `${constraint.PackageId} ${constraint.InstalledVersion} requires ${constraint.Range}`
              ).join("; ")}
            </span>
          </li>
        `)}
      </ul>
    </section>`;
  }

  private renderJobProgress(): unknown {
    if (!this.jobProgress) return nothing;
    return html`
      <div class="loading" role="status" aria-live="polite" aria-label="Updating packages">
        <span class="spinner large"></span>
        <div class="loading-body">
          <span class="loading-stage">${this.jobProgress.Stage}</span>
          <div
            class="progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${this.jobProgress.Percent}
          >
            <div class="progress-fill" style="width: ${this.jobProgress.Percent}%"></div>
          </div>
        </div>
        <button
          class="secondary-btn"
          title="Cancel this update and roll back the versions already written"
          ?disabled=${!this._jobId}
          @click=${async () => await this.cancelJobAsync()}
        >Cancel</button>
      </div>
    `;
  }

  private renderLoading(): unknown {
    if (this._loadTask.status !== TaskStatus.PENDING) return nothing;
    const progress = this.scanProgress;
    const progressPercent = Math.max(0, Math.min(100, Math.round(progress?.Percent ?? 0)));
    const progressCount = progress && progress.Total > 0
      ? html`<span class="loading-count">${progress.Completed} of ${progress.Total}</span>`
      : nothing;
    return html`
      <div class="loading" role="status" aria-live="polite" aria-label="Loading">
        <span class="spinner large"></span>
        <div class="loading-body">
          <span class="loading-stage">${progress?.Stage || "Checking for updates..."}</span>
          ${progressCount}
          <div
            class="progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${progressPercent}
          >
            <div class="progress-fill" style="width: ${progressPercent}%"></div>
          </div>
        </div>
      </div>
    `;
  }

  private renderEmpty(): unknown {
    const show = this._loadTask.status !== TaskStatus.PENDING
      && this._loadTask.status !== TaskStatus.ERROR
      && this.packages.length === 0
      && this.blockedPackages.length === 0;
    if (!show) return nothing;
    return html`
      <div class="empty">
        <span class="codicon codicon-check"></span>
        All packages are up to date
      </div>
    `;
  }

  private renderNoMatch(): unknown {
    const show = this._loadTask.status !== TaskStatus.PENDING
      && this._loadTask.status !== TaskStatus.ERROR
      && this.packages.length > 0
      && this.visiblePackages.length === 0;
    if (!show) return nothing;
    return html`
      <div class="empty">
        <span class="codicon codicon-search"></span>
        No matching updates
      </div>
    `;
  }

  private get loadErrorMessage(): string {
    const error = this._loadTask.error;
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : "";
  }

  private renderError(): unknown {
    if (this._loadTask.status !== TaskStatus.ERROR) return nothing;
    const message = this.loadErrorMessage;
    // An aborted run is the view's own doing (a superseded request), not a failure to report.
    if (isCancelledMessage(message)) return nothing;
    return html`
      <div class="error" role="alert">
        <span class="codicon codicon-error"></span>
        <div class="empty-title">Failed to check for updates</div>
        ${message ? html`<div class="empty-hint">${message}</div>` : nothing}
      </div>
    `;
  }

  private renderFailure(): unknown {
    if (!this.failure) return nothing;
    return html`<actionable-error
      .failure=${this.failure}
      heading=${this.failureHeading}
    ></actionable-error>`;
  }

  private renderPackageList(): unknown {
    const visible = this.visiblePackages;
    const show = this._loadTask.status !== TaskStatus.PENDING && visible.length > 0;
    if (!show) return nothing;
    const groups = this.groupedVisiblePackages;
    // A single framework line has nothing to separate, so it gets no header.
    const showGroupHeaders = shouldShowFrameworkGroups(groups);
    return html`
      <div class="package-list" role="list" aria-label="Outdated packages">
        ${groups.map(
          (group) => html`
            ${showGroupHeaders
              ? html`
                  <label class="group-header">
                    <input
                      type="checkbox"
                      class="group-select"
                      aria-label="Select all ${group.label} updates"
                      .checked=${group.packages.length > 0 && group.packages.every((pkg) => pkg.Selected)}
                      .indeterminate=${group.packages.some((pkg) => pkg.Selected) && !group.packages.every((pkg) => pkg.Selected)}
                      @change=${(e: Event) =>
                        this.toggleGroupSelection(
                          group.packages,
                          (e.target as HTMLInputElement).checked
                        )}
                    />
                    <span>${group.label}</span>
                    <span class="group-count">${group.packages.length}</span>
                  </label>
                `
              : nothing}
            ${group.packages.map((pkg) => this.renderPackageRow(pkg))}
          `
        )}
      </div>
    `;
  }

  override render(): unknown {
    const visible = this.visiblePackages;
    const isLoading = this._loadTask.status === TaskStatus.PENDING;
    const updateWord = visible.length === 1 ? "update" : "updates";

    return html`
      <div class="updates-container" aria-busy=${isLoading}>
        <div class="list-header">
          <div>
            <div class="list-title">Updates</div>
            <div class="list-subtitle">
              ${visible.length} ${updateWord} available${this.renderStatusSuffix()}
            </div>
          </div>
          <div class="list-actions">
            ${this.renderHeaderActions()}
          </div>
        </div>
        ${this.renderUpdatePlan()}
        ${this.renderInfoBanner()}
        ${this.renderConflicts()}
        ${this.renderFailure()}
        ${this.renderJobProgress()}
        ${this.renderLoading()}
        ${this.renderEmpty()}
        ${this.renderNoMatch()}
        ${this.renderError()}
        ${this.renderPackageList()}
      </div>
    `;
  }
}
