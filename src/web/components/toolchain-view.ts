import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";
import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "@/web/registrations";
import type {
  RunWorkloadCommandResponse,
  ToolchainHealth,
  ToolchainIssue,
  WorkloadAction,
} from "@/common/rpc/types";
import "./sdk-select";

/**
 * Toolchain tab: which .NET SDK the extension will use for this workspace, how
 * to change it, and what is wrong when a restore cannot start.
 *
 * The check runs `dotnet --version` and a real `dotnet msbuild -getProperty`
 * evaluation in the same directory the extension uses for restores, so a broken
 * SDK is visible before the user starts an update.
 */
@customElement("toolchain-view")
export class ToolchainView extends LitElement {
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
      }

      .content {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
      }

      .header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }

      .list-title {
        font-size: 1.05em;
        font-weight: 600;
      }

      .list-subtitle {
        color: var(--vscode-descriptionForeground);
        font-size: 0.92em;
      }

      .spacer {
        flex: 1;
      }

      .card {
        border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
        border-radius: var(--npm-radius, 10px);
        background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .rows {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        font-size: 0.95em;
      }

      .key {
        color: var(--vscode-descriptionForeground);
      }

      .value {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .ok {
        color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
      }

      .bad {
        color: var(--vscode-errorForeground);
      }

      .issue {
        border-left: 3px solid var(--vscode-editorWarning-foreground);
        padding: 6px 0 6px 10px;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .issue-summary {
        overflow-wrap: anywhere;
      }

      .issue-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 2px;
      }

      .issue-hint {
        color: var(--vscode-descriptionForeground);
        font-size: 0.92em;
        overflow-wrap: anywhere;
      }

      button {
        font-family: inherit;
        font-size: inherit;
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
        border: 1px solid transparent;
        border-radius: 2px;
        padding: 2px 8px;
        cursor: pointer;
      }

      button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }

      button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
      }

      button:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .checking {
        display: flex;
        flex-direction: column;
        gap: 5px;
        border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
        border-radius: var(--npm-radius, 10px);
        background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
        padding: 8px 12px;
      }

      .checking-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.92em;
        color: var(--vscode-descriptionForeground);
      }

      .progress-track {
        height: 4px;
        width: 100%;
        border-radius: 2px;
        overflow: hidden;
        background: color-mix(in srgb, var(--vscode-progressBar-background) 30%, transparent);
      }

      .progress-fill {
        height: 100%;
        width: 40%;
        border-radius: 2px;
        background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
        animation: npm-indeterminate 1.2s ease-in-out infinite;
      }

      @keyframes npm-indeterminate {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(250%);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .progress-fill {
          animation: none;
          width: 100%;
          opacity: 0.6;
        }
      }

      pre {
        margin: 4px 0 0;
        padding: 8px;
        max-height: 220px;
        overflow: auto;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 12px);
        background: var(--vscode-textCodeBlock-background);
        border-radius: 2px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .feedback {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
      }
    `,
  ];

  @property({ attribute: false }) projectPaths: string[] = [];

  @state() private refreshToken = 0;
  @state() private copyFeedback = "";
  @state() private expandedIssue: number | null = null;
  @state() private workloadBusy: WorkloadAction | null = null;
  @state() private workloadResult: RunWorkloadCommandResponse | null = null;
  @state() private workloadFeedback = "";
  @state() private cleanupFeedback = "";

  private readonly _healthTask = new Task(this, {
    args: () => [this.projectPaths.join("|"), this.refreshToken] as const,
    task: async ([paths, refreshToken], { signal }) => {
      const projectPaths = paths ? paths.split("|") : [];
      const result = await hostApi.getToolchainHealthAsync(
        { ProjectPaths: projectPaths, ForceRefresh: refreshToken > 0 },
        signal
      );
      if (!result.ok) throw new Error(result.error);
      this.reportCount(result.value.Health);
      return result.value.Health;
    },
  });

  private reportCount(health: ToolchainHealth): void {
    this.dispatchEvent(
      new CustomEvent<number>("count-changed", {
        detail: health.Issues.length,
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * Deleting an orphaned band folder needs administrator rights, so the tab
   * offers the exact command instead of running it.
   */
  private async onCopyCleanupAsync(paths: string[]): Promise<void> {
    const commands = paths.map((fullPath) => {
      const name = fullPath.split(/[\\/]/).pop() ?? "band";
      return `Rename-Item -LiteralPath "${fullPath}" "${name}.bak"`;
    });
    const script = ["# Run in an elevated PowerShell, then press Re-check", ...commands].join("\n");
    try {
      await navigator.clipboard.writeText(script);
      this.cleanupFeedback = "Cleanup command copied.";
    } catch {
      this.cleanupFeedback = "Copy failed — see the output channel.";
    }
    this.requestUpdate();
  }

  private async onCopyDiagnosticsAsync(): Promise<void> {
    const result = await hostApi.runToolchainDiagnosticsAsync({ ProjectPaths: this.projectPaths });
    if (!result.ok) {
      this.copyFeedback = "Could not collect diagnostics.";
      return;
    }
    try {
      await navigator.clipboard.writeText(result.value.Report);
      this.copyFeedback = "Diagnostics copied (credentials redacted).";
    } catch {
      this.copyFeedback = "Copy failed — see the output channel.";
    }
  }

  private onRecheck(): void {
    this.copyFeedback = "";
    this.expandedIssue = null;
    this.refreshToken += 1;
  }

  private isWorkloadIssue(issue: ToolchainIssue): boolean {
    return issue.Kind === "WorkloadManifestConflict" || issue.Kind === "SdkResolutionFailure";
  }

  /**
   * `dotnet workload update|repair` changes installed manifests on this machine,
   * so it always runs after an explicit confirmation and shows the raw output.
   */
  private async runWorkloadAsync(action: WorkloadAction): Promise<void> {
    const sdk = this._healthTask.value?.SdkVersion ?? "the selected SDK";
    const verb = action === "update" ? "Update" : "Repair";
    const confirm = await hostApi.showConfirmationAsync({
      Message: `${verb} .NET workloads for SDK ${sdk}?`,
      Detail:
        `Runs "dotnet workload ${action}" for the SDK this workspace uses. ` +
        "It changes the installed workload manifests for that SDK and may need an elevated terminal.",
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.workloadBusy = action;
    this.workloadFeedback = "";
    this.workloadResult = null;
    const result = await hostApi.runWorkloadCommandAsync({
      Action: action,
      ProjectPaths: this.projectPaths,
    });
    this.workloadBusy = null;

    if (!result.ok) {
      this.workloadFeedback = `Could not run dotnet workload ${action}: ${result.error}`;
      return;
    }

    this.workloadResult = result.value;
    if (result.value.Succeeded) {
      this.workloadFeedback = `dotnet workload ${action} completed — re-checking the toolchain.`;
      this.refreshToken += 1;
      return;
    }
    this.workloadFeedback = result.value.NeedsElevation
      ? `dotnet workload ${action} needs administrator rights. Run it in an elevated terminal, then Re-check.`
      : `dotnet workload ${action} failed (exit ${result.value.ExitCode ?? "unknown"}).`;
  }

  /** The first pin that is not installed, for the "Install SDK" action. */
  private recommendedVersion(health: ToolchainHealth): string {
    const candidates = [health.PinnedSdkVersion].filter(
      (version): version is string => Boolean(version)
    );
    return candidates.find(
      (version) => !health.InstalledSdks.some((sdk) => sdk.Version === version)
    ) ?? candidates[0] ?? "";
  }

  private renderIssue(issue: ToolchainIssue, index: number): unknown {
    const expanded = this.expandedIssue === index;
    return html`
      <div class="issue">
        <div class="issue-summary">
          <span class="codicon codicon-warning"></span> ${issue.Summary}
        </div>
        <div class="issue-hint">${issue.Hint}</div>
        ${this.isWorkloadIssue(issue)
          ? html`<div class="issue-actions">
              <button
                ?disabled=${this.workloadBusy !== null}
                @click=${async () => await this.runWorkloadAsync("update")}
              >Update workloads</button>
              <button
                ?disabled=${this.workloadBusy !== null}
                @click=${async () => await this.runWorkloadAsync("repair")}
              >Repair workloads</button>
            </div>`
          : nothing}
        ${issue.Detail
          ? html`
              <div>
                <button @click=${() => { this.expandedIssue = expanded ? null : index; }}>
                  ${expanded ? "Hide output" : "Show output"}
                </button>
              </div>
              ${expanded ? html`<pre>${issue.Detail}</pre>` : nothing}
            `
          : nothing}
      </div>
    `;
  }

  /**
   * The probe is a single host call, so the bar is indeterminate: it reports that
   * a fresh check is running (and keeps the previous result on screen) without
   * inventing a percentage.
   */
  private renderChecking(): unknown {
    return html`
      <div class="checking">
        <div class="checking-label" role="status" aria-live="polite">
          <span class="codicon codicon-loading codicon-modifier-spin"></span>
          Checking the .NET SDK…
        </div>
        <div class="progress-track" role="progressbar" aria-label="Checking the .NET SDK" aria-valuetext="Checking">
          <div class="progress-fill"></div>
        </div>
      </div>
    `;
  }

  private renderWorkloadResult(): unknown {
    if (this.workloadBusy) {
      return html`
        <div class="checking">
          <div class="checking-label" role="status" aria-live="polite">
            <span class="codicon codicon-loading codicon-modifier-spin"></span>
            Running dotnet workload ${this.workloadBusy}… (this can take several minutes)
          </div>
          <div class="progress-track" role="progressbar" aria-label="Running dotnet workload" aria-valuetext="Running">
            <div class="progress-fill"></div>
          </div>
        </div>
      `;
    }
    if (!this.workloadResult && !this.workloadFeedback) return nothing;
    return html`
      <div class="card">
        ${this.workloadFeedback
          ? html`<div class="${this.workloadResult?.Succeeded === false ? "bad" : ""}" role="status">${this.workloadFeedback}</div>`
          : nothing}
        ${this.workloadResult
          ? html`<pre>${this.workloadResult.Output || "(no output)"}</pre>`
          : nothing}
      </div>
    `;
  }

  private renderHealthy(): unknown {
    return html`<div class="card">
      <div class="ok">
        <span class="codicon codicon-pass"></span> No toolchain problems detected.
      </div>
      <div class="list-subtitle">
        Restores, installs and updates run with the SDK above. If a project pins a
        different SDK in its <code>global.json</code>, the extension uses that pin for
        that project.
      </div>
    </div>`;
  }

  override render(): unknown {
    const isPending = this._healthTask.status === TaskStatus.PENDING;
    const health = this._healthTask.value;

    return html`
      <div class="content" aria-busy=${isPending}>
        <div class="header">
          <div>
            <div class="list-title">dotnet toolchain</div>
            <div class="list-subtitle">${this.renderSubtitle(health)}</div>
          </div>
          <div class="spacer"></div>
          <button ?disabled=${isPending} @click=${this.onRecheck}>Re-check</button>
          <button @click=${async () => await this.onCopyDiagnosticsAsync()}>Copy diagnostics</button>
          ${this.copyFeedback ? html`<span class="feedback" role="status">${this.copyFeedback}</span>` : nothing}
        </div>

        ${isPending ? this.renderChecking() : nothing}
        ${this._healthTask.status === TaskStatus.ERROR
          ? html`<div class="card bad">Could not check the .NET toolchain.</div>`
          : nothing}
        ${health ? this.renderSummary(health) : nothing}
      </div>
    `;
  }

  private describePinMatch(health: ToolchainHealth): string {
    if (health.SdkMatchesPin === undefined) return "n/a";
    return health.SdkMatchesPin ? "yes" : "no";
  }

  private renderSubtitle(health: ToolchainHealth | undefined): string {
    if (!health) return "Checking the .NET SDK…";
    if (!health.DotnetFound) return "dotnet was not found on PATH";
    const issues = health.Issues.length;
    if (issues === 0) return `Using .NET SDK ${health.SdkVersion ?? "unknown"}`;
    const plural = issues === 1 ? "" : "s";
    return `${issues} problem${plural} found with the .NET toolchain`;
  }

  private renderSummary(health: ToolchainHealth): unknown {
    let selected = health.SdkVersion ?? "unknown";
    if (!health.DotnetFound) selected = "not found";
    const matches = this.describePinMatch(health);
    const buildDiffers = Boolean(health.BuildSdkVersion && health.BuildSdkVersion !== health.SdkVersion);
    const statusOk = Boolean(health.SdkStatus && /up to date/i.test(health.SdkStatus));
    const buildClass = buildDiffers ? "bad" : "ok";
    const statusClass = statusOk ? "ok" : "bad";

    return html`
      <div class="card">
        <div class="rows">
          <span class="key">dotnet</span>
          <span class="value">${health.DotnetPath ?? "dotnet (PATH)"}</span>
          <span class="key">selected SDK</span>
          <span class="value ${health.DotnetFound ? "" : "bad"}">${selected}</span>
          <span class="key">global.json pin</span>
          <span class="value">${health.PinnedSdkVersion ?? "none"}${health.GlobalJsonPath ? ` — ${health.GlobalJsonPath}` : ""}</span>
          ${health.BuildSdkVersion
            ? html`
                <span class="key">build SDK</span>
                <span class="value ${buildClass}">${health.BuildSdkVersion}</span>
              `
            : nothing}
          ${health.SdkStatus
            ? html`
                <span class="key">SDK status</span>
                <span class="value ${statusClass}">${health.SdkStatus}</span>
              `
            : nothing}
          <span class="key">satisfies pin</span>
          <span class="value ${matches === "no" ? "bad" : ""}">${matches}</span>
          <span class="key">project evaluation</span>
          <span class="value ${health.ProjectEvaluationFailed ? "bad" : "ok"}">${health.ProjectEvaluationFailed ? "failed" : "ok"}</span>
          <span class="key">checked</span>
          <span class="value">${new Date(health.CheckedAt).toLocaleTimeString()}</span>
        </div>
        <sdk-select
          .sdks=${health.InstalledSdks}
          .selected=${health.PinnedSdkVersion ?? ""}
          .projectPaths=${this.projectPaths}
          .recommended=${this.recommendedVersion(health)}
          @sdk-changed=${this.onRecheck}
        ></sdk-select>
      </div>

      ${health.Issues.length === 0 ? this.renderHealthy() : nothing}
      ${health.Issues.length > 0
        ? html`<div class="card">${health.Issues.map((issue, index) => this.renderIssue(issue, index))}</div>`
        : nothing}
      ${this.renderWorkloadResult()}
      ${health.OrphanedManifestBands && health.OrphanedManifestBands.length > 0
        ? html`
            <div class="card">
              <div class="key">left-over manifest bands (no installed SDK)</div>
              <div class="value">${health.OrphanedManifestBands.join(", ")}</div>
              <div class="list-subtitle">
                They are still composed by newer SDKs and are not removed by
                <code>dotnet workload update</code> or <code>repair</code>.
              </div>
              <div class="issue-actions">
                <button @click=${async () => await this.onCopyCleanupAsync(health.OrphanedManifestBands ?? [])}>
                  Copy cleanup command
                </button>
                ${this.cleanupFeedback
                  ? html`<span class="feedback" role="status">${this.cleanupFeedback}</span>`
                  : nothing}
              </div>
            </div>
          `
        : nothing}
      ${health.InstalledSdks.length > 0
        ? html`<div class="card">
            <div class="key">installed SDKs</div>
            <div class="value">${health.InstalledSdks.map((sdk) => sdk.Version).join(", ")}</div>
          </div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "toolchain-view": ToolchainView;
  }
}
