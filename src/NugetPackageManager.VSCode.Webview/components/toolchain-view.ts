import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";
import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "@/web/registrations";
import { CopyTextAsync, CopyToolchainDiagnosticsAsync } from "@/web/utilities/diagnostics";
import { RecommendedSdkVersion } from "@/web/utilities/toolchain";
import type {
  LocalTool,
  LocalToolManifest,
  RunWorkloadCommandResponse,
  ToolchainHealth,
  ToolchainIssue,
  WorkloadAction,
} from "@/common/rpc/types";
import "./sdk-select";

/** Inline result of one tool update, rendered under its row. */
type ToolRowStatus = { readonly text: string; readonly bad: boolean };

/** `dotnet tool restore` was attempted, killed after the host timeout, and the
 * manifest keeps the new version: the row must say both things at once. */
const MANIFEST_UPDATED_TIMED_OUT = "manifest updated - restore timed out";

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

      /* Repo tools card */

      .tool-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
        border-top: 1px solid var(--npm-border, var(--vscode-panelSection-border));
        padding-top: 8px;
      }

      .tool-group:first-of-type {
        border-top: none;
        padding-top: 0;
      }

      .tool-group-header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        font-size: 0.95em;
      }

      .tool-path {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 12px);
        overflow-wrap: anywhere;
      }

      .badge {
        border: 1px solid var(--vscode-descriptionForeground);
        border-radius: 999px;
        padding: 0 6px;
        font-size: 0.8em;
        color: var(--vscode-descriptionForeground);
      }

      .badge-root {
        border-color: var(--vscode-focusBorder);
        color: var(--vscode-focusBorder);
      }

      .tool-problem {
        display: flex;
        align-items: flex-start;
        gap: 5px;
        color: var(--vscode-editorWarning-foreground);
        font-size: 0.9em;
        overflow-wrap: anywhere;
      }

      .tool-rows {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .tool-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) max-content max-content;
        align-items: center;
        gap: 2px 10px;
        padding: 4px 0;
      }

      .tool-main {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      .tool-command {
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .tool-id {
        color: var(--vscode-descriptionForeground);
        font-size: 0.88em;
        overflow-wrap: anywhere;
      }

      .tool-version {
        color: var(--vscode-descriptionForeground);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .tool-version-latest {
        color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
      }

      .tool-status {
        grid-column: 1 / -1;
        font-size: 0.88em;
        color: var(--vscode-descriptionForeground);
        overflow-wrap: anywhere;
      }

      .tool-status-bad {
        color: var(--vscode-errorForeground);
      }

      .tools-empty {
        display: flex;
        flex-direction: column;
        gap: 4px;
        color: var(--vscode-descriptionForeground);
        font-size: 0.92em;
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
  @state() private toolsRefreshToken = 0;
  @state() private toolsBusyKeys = new Set<string>();
  @state() private toolStatuses = new Map<string, ToolRowStatus>();

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

  /**
   * Local tools are read per render of the tab; the card re-runs whenever the
   * project list or the tab-level refresh token changes. The workspace folders
   * are unknown to the webview, so `WorkspaceRoots` stays empty and the host
   * resolves them itself.
   */
  private readonly _toolsTask = new Task(this, {
    args: () => [this.projectPaths.join("|"), this.toolsRefreshToken] as const,
    task: async ([paths], { signal }) => {
      const projectPaths = paths ? paths.split("|") : [];
      const result = await hostApi.getLocalToolsAsync(
        { WorkspaceRoots: [], ProjectPaths: projectPaths, ResolveLatest: true },
        signal
      );
      if (!result.ok) throw new Error(result.error);
      return result.value.Manifests;
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
    this.cleanupFeedback = (await CopyTextAsync(script))
      ? "Cleanup command copied."
      : "Copy failed — see the output channel.";
    this.requestUpdate();
  }

  private async onCopyDiagnosticsAsync(): Promise<void> {
    this.copyFeedback = await CopyToolchainDiagnosticsAsync(
      this.projectPaths,
      "Diagnostics copied (credentials redacted)."
    );
  }

  private onRecheck(): void {
    this.copyFeedback = "";
    this.expandedIssue = null;
    this.refreshToken += 1;
    this.toolsRefreshToken += 1;
  }

  /** Re-runs the toolchain probe, e.g. when the tab becomes active. */
  async RefreshAsync(): Promise<void> {
    this.onRecheck();
    await this.updateComplete;
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

  private renderIssue(issue: ToolchainIssue, index: number): unknown {
    return html`
      <div class="issue">
        <div class="issue-summary">
          <span class="codicon codicon-warning"></span> ${issue.Summary}
        </div>
        <div class="issue-hint">${issue.Hint}</div>
        ${this.renderWorkloadActions(issue)}
        ${this.renderIssueDetail(issue, index)}
      </div>
    `;
  }

  private renderWorkloadActions(issue: ToolchainIssue): unknown {
    if (!this.isWorkloadIssue(issue)) return nothing;
    return html`<div class="issue-actions">
      <button
        ?disabled=${this.workloadBusy !== null}
        @click=${async () => await this.runWorkloadAsync("update")}
      >Update workloads</button>
      <button
        ?disabled=${this.workloadBusy !== null}
        @click=${async () => await this.runWorkloadAsync("repair")}
      >Repair workloads</button>
    </div>`;
  }

  private renderIssueDetail(issue: ToolchainIssue, index: number): unknown {
    if (!issue.Detail) return nothing;
    const expanded = this.expandedIssue === index;
    const label = expanded ? "Hide output" : "Show output";
    return html`
      <div>
        <button @click=${() => { this.expandedIssue = expanded ? null : index; }}>${label}</button>
      </div>
      ${expanded ? html`<pre>${issue.Detail}</pre>` : nothing}
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
        ${this.renderWorkloadFeedback()}
        ${this.renderWorkloadOutput()}
      </div>
    `;
  }

  private renderWorkloadFeedback(): unknown {
    if (!this.workloadFeedback) return nothing;
    const tone = this.workloadResult?.Succeeded === false ? "bad" : "";
    return html`<div class="${tone}" role="status">${this.workloadFeedback}</div>`;
  }

  private renderWorkloadOutput(): unknown {
    if (!this.workloadResult) return nothing;
    return html`<pre>${this.workloadResult.Output || "(no output)"}</pre>`;
  }

  private renderOrphanedBands(bands: string[] | undefined): unknown {
    if (!bands || bands.length === 0) return nothing;
    return html`
      <div class="card">
        <div class="key">left-over manifest bands (no installed SDK)</div>
        <div class="value">${bands.join(", ")}</div>
        <div class="list-subtitle">
          They are still composed by newer SDKs and are not removed by
          <code>dotnet workload update</code> or <code>repair</code>.
        </div>
        <div class="issue-actions">
          <button @click=${async () => await this.onCopyCleanupAsync(bands)}>
            Copy cleanup command
          </button>
          ${this.renderCleanupFeedback()}
        </div>
      </div>
    `;
  }

  private renderCleanupFeedback(): unknown {
    if (!this.cleanupFeedback) return nothing;
    return html`<span class="feedback" role="status">${this.cleanupFeedback}</span>`;
  }

  /**
   * The webview never receives the workspace folders — the host resolves the
   * empty `WorkspaceRoots` request itself — so the workspace root is inferred as
   * the deepest folder that still contains every project path. A manifest that
   * lives outside that folder keeps its absolute path.
   */
  private inferWorkspaceRoot(): string {
    const folders: string[] = [];
    for (const projectPath of this.projectPaths) {
      const normalised = projectPath.replace(/\\/g, "/");
      const index = normalised.lastIndexOf("/");
      folders.push(index > 0 ? normalised.slice(0, index) : "");
    }
    const candidates = folders.filter((folder) => folder.length > 0);
    const [first] = candidates;
    if (first === undefined) return "";
    let root = first;
    for (const folder of candidates.slice(1)) {
      while (root.length > 0 && !folder.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
        const index = root.lastIndexOf("/");
        root = index > 0 ? root.slice(0, index) : "";
      }
    }
    return root;
  }

  private manifestDisplayPath(manifestPath: string): string {
    const normalised = manifestPath.replace(/\\/g, "/");
    const root = this.inferWorkspaceRoot();
    if (!root) return manifestPath;
    const prefix = `${root.toLowerCase()}/`;
    if (!normalised.toLowerCase().startsWith(prefix)) return manifestPath;
    const relative = normalised.slice(prefix.length);
    return relative.length > 0 ? relative : manifestPath;
  }

  private toolKey(manifestPath: string, toolId: string): string {
    return `${manifestPath}|${toolId}`;
  }

  private setToolStatus(key: string, text: string, bad = false): void {
    const next = new Map(this.toolStatuses);
    next.set(key, { text, bad });
    this.toolStatuses = next;
  }

  private markToolBusy(key: string, busy: boolean): void {
    const next = new Set(this.toolsBusyKeys);
    if (busy) next.add(key);
    else next.delete(key);
    this.toolsBusyKeys = next;
  }

  /**
   * Updates exactly one tool, then verifies with `dotnet tool restore` on the
   * host. The manifest write is optimistic-locked on the rendered version, and a
   * failed restore leaves the manifest updated — the row reports both facts.
   */
  private async onUpdateToolAsync(manifest: LocalToolManifest, tool: LocalTool): Promise<void> {
    const key = this.toolKey(manifest.Path, tool.Id);
    const target = tool.LatestVersion;
    if (this.toolsBusyKeys.has(key) || !target) return;

    this.markToolBusy(key, true);
    this.setToolStatus(key, `Updating ${tool.Id} to ${target}…`);
    try {
      const result = await hostApi.updateLocalToolAsync({
        ManifestPath: manifest.Path,
        ToolId: tool.Id,
        ExpectedVersion: tool.Version,
        Version: target,
        WorkspaceRoots: [],
      });

      if (!result.ok) {
        this.setToolStatus(
          key,
          /cancel/i.test(result.error) ? "Update cancelled." : `Could not update ${tool.Id}: ${result.error}`,
          !/cancel/i.test(result.error)
        );
        return;
      }

      const response = result.value;
      const restore = response.Restore;
      if (!restore) {
        this.setToolStatus(key, `Updated ${tool.Id} to ${response.Version}.`);
      } else if (restore.Ok) {
        this.setToolStatus(key, `Updated ${tool.Id} to ${response.Version} — dotnet tool restore succeeded.`);
      } else if (restore.TimedOut) {
        this.setToolStatus(key, MANIFEST_UPDATED_TIMED_OUT, true);
      } else {
        this.setToolStatus(
          key,
          `manifest updated - restore failed: ${restore.Message ?? "unknown error"}`,
          true
        );
      }
      this.toolsRefreshToken += 1;
    } finally {
      this.markToolBusy(key, false);
    }
  }

  private renderToolsCard(): unknown {
    const status = this._toolsTask.status;
    const manifests = this._toolsTask.value ?? [];
    return html`
      <div class="card">
        <div class="header">
          <div>
            <div class="list-title">Repo tools</div>
            <div class="list-subtitle">
              Local .NET tools pinned in <code>.config/dotnet-tools.json</code>. Each update
              is one tool at a time and is verified with <code>dotnet tool restore</code>.
            </div>
          </div>
        </div>
        ${status === TaskStatus.PENDING ? this.renderToolsLoading() : nothing}
        ${status === TaskStatus.ERROR ? this.renderToolsError() : nothing}
        ${status === TaskStatus.COMPLETE && manifests.length === 0 ? this.renderToolsEmpty() : nothing}
        ${manifests.map((manifest) => this.renderManifestGroup(manifest))}
      </div>
    `;
  }

  private renderToolsLoading(): unknown {
    return html`
      <div class="feedback" role="status">
        <span class="codicon codicon-loading codicon-modifier-spin"></span>
        Reading local tool manifests…
      </div>
    `;
  }

  private renderToolsError(): unknown {
    const error = this._toolsTask.error;
    const message = error instanceof Error ? error.message : String(error);
    return html`<div class="bad" role="status">Could not read local tool manifests: ${message}</div>`;
  }

  private renderToolsEmpty(): unknown {
    return html`
      <div class="tools-empty">
        <div>No local tool manifest in this workspace.</div>
        <div>
          Add tools with <code>dotnet tool install --local</code>, which creates
          <code>.config/dotnet-tools.json</code>.
        </div>
      </div>
    `;
  }

  private renderManifestGroup(manifest: LocalToolManifest): unknown {
    const count = manifest.Tools.length;
    return html`
      <div class="tool-group">
        <div class="tool-group-header">
          <span class="tool-path">${this.manifestDisplayPath(manifest.Path)}</span>
          ${manifest.IsRoot ? html`<span class="badge badge-root">isRoot</span>` : nothing}
          <span class="list-subtitle">${count === 1 ? "1 tool" : `${count} tools`}</span>
        </div>
        ${manifest.Problems.map(
          (problem) => html`
            <div class="tool-problem">
              <span class="codicon codicon-warning"></span>
              <span>${problem}</span>
            </div>
          `
        )}
        <div class="tool-rows">
          ${manifest.Tools.map((tool) => this.renderToolRow(manifest, tool))}
        </div>
      </div>
    `;
  }

  private renderToolRow(manifest: LocalToolManifest, tool: LocalTool): unknown {
    const key = this.toolKey(manifest.Path, tool.Id);
    const busy = this.toolsBusyKeys.has(key);
    const commands = tool.Commands.length > 0 ? tool.Commands.join(", ") : tool.Id;
    const showUpdate = tool.UpdateAvailable && Boolean(tool.LatestVersion);
    return html`
      <div class="tool-row">
        <div class="tool-main">
          <span class="tool-command">${commands}</span>
          <span class="tool-id">${tool.Id}</span>
          ${tool.Pinned ? html`<span class="badge">pinned</span>` : nothing}
        </div>
        <span class="tool-version">
          ${showUpdate
            ? html`${tool.Version} <span class="tool-version-latest">→ ${tool.LatestVersion}</span>`
            : tool.Version}
        </span>
        ${showUpdate
          ? html`
              <button
                ?disabled=${busy}
                @click=${async () => await this.onUpdateToolAsync(manifest, tool)}
              >Update</button>
            `
          : html`<span></span>`}
        ${this.renderToolStatus(key)}
      </div>
    `;
  }

  private renderToolStatus(key: string): unknown {
    const entry = this.toolStatuses.get(key);
    if (!entry) return nothing;
    return html`
      <div class="tool-status ${entry.bad ? "tool-status-bad" : ""}" role="status">
        ${entry.text}
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
        ${this.renderToolsCard()}
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
          .recommended=${RecommendedSdkVersion(health)}
          @sdk-changed=${this.onRecheck}
        ></sdk-select>
      </div>

      ${health.Issues.length === 0 ? this.renderHealthy() : nothing}
      ${health.Issues.length > 0
        ? html`<div class="card">${health.Issues.map((issue, index) => this.renderIssue(issue, index))}</div>`
        : nothing}
      ${this.renderWorkloadResult()}
      ${this.renderOrphanedBands(health.OrphanedManifestBands)}
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
