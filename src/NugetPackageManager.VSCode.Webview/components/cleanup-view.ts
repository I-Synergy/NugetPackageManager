import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "@/web/registrations";
import { runCleanupJobAsync, runAddMissingDefinitionsJobAsync } from "@/web/jobs";
import type { CleanupReport, MissingDefinition } from "@/common/rpc/types";
import "./dependency-issues";
import type { DependencyIssues } from "./dependency-issues";

@customElement("cleanup-view")
export class CleanupView extends LitElement {
  static override readonly styles = [
    codicon,
    scrollableBase,
    sharedStyles,
    css`
      :host {
        display: flex;
        flex: 1;
        width: 100%;
        min-height: 0;
        overflow: hidden;
      }

      .cleanup-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }

      .cleanup-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding-bottom: 8px;
      }

      .cleanup-container .package-list {
        flex: none;
        overflow: visible;
      }

      .stat-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        margin: 8px;
      }

      .stat {
        padding: 9px 11px;
        border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
        border-radius: var(--npm-radius, 10px);
        background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
      }

      .stat b {
        display: block;
        font-size: 16px;
      }

      .stat span {
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
      }

      .unused-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 5px 8px;
        padding: 10px 12px;
        border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
        border-radius: var(--npm-radius, 10px);
        background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
      }

      .unused-row .package-id {
        flex: 1;
        min-width: 0;
        font-weight: 600;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .unused-row .file-name {
        color: var(--vscode-descriptionForeground);
        font-size: 10px;
        white-space: nowrap;
      }

      .missing-card {
        margin: 8px;
        padding: 10px 12px;
        border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
        border-radius: var(--npm-radius, 10px);
        background: var(--vscode-inputValidation-warningBackground, transparent);
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
      }

      .missing-card .missing-title {
        color: var(--vscode-foreground);
        font-weight: 600;
        margin-bottom: 4px;
      }

      .missing-card .missing-hint {
        margin-bottom: 6px;
      }

      .missing-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
        color: var(--vscode-foreground);
      }

      .missing-row .missing-id {
        flex: 1;
        min-width: 0;
        font-weight: 600;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .missing-row .missing-version {
        font-size: 11px;
        white-space: nowrap;
      }

      .missing-row .missing-reason {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
      }

      .missing-row .file-name {
        color: var(--vscode-descriptionForeground);
        font-size: 10px;
        white-space: nowrap;
      }

      .missing-row .project-name {
        color: var(--vscode-descriptionForeground);
        font-size: 10px;
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  /** Projects to analyse for transitive duplicates; empty = discover them. */
  @property({ attribute: false }) projectPaths: string[] = [];

  @state() private report: CleanupReport | null = null;
  @state() private isLoading = false;
  @state() private isRemoving = false;
  @state() private isAdding = false;
  @state() private statusText = "";
  @state() private errorMessage = "";
  @state() private dependencyCount = 0;
  private _jobId = "";
  private _addJobId = "";

  async LoadCleanupReportAsync(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = "";
    this.requestUpdate();
    try {
      const result = await hostApi.getCleanupReportAsync({});
      if (!result.ok) {
        this.errorMessage = result.error;
        return;
      }
      this.report = result.value;
      this.reportCount();
    } finally {
      this.isLoading = false;
      this.requestUpdate();
    }
  }

  /**
   * Refresh everything this tab shows: the unused-entry report **and** the
   * transitive-duplicate analysis. The latter has its own async task, so a report
   * reload alone used to leave the direct-reference list stale until the tab was
   * remounted.
   */
  async RefreshAsync(): Promise<void> {
    const issues = this.shadowRoot?.querySelector("dependency-issues") as DependencyIssues | null;
    await Promise.all([
      this.LoadCleanupReportAsync(),
      issues?.ReloadAsync() ?? Promise.resolve(),
    ]);
  }

  /** The Cleanup badge covers unused props entries plus removable duplicates. */
  private reportCount(): void {
    this.dispatchEvent(new CustomEvent<number>("count-changed", {
      detail: (this.report?.Unused.length ?? 0) + this.dependencyCount,
      bubbles: true,
      composed: true,
    }));
  }

  private async onDependencyCountChangedAsync(event: CustomEvent<number>): Promise<void> {
    this.dependencyCount = event.detail;
    this.reportCount();
    await Promise.resolve();
  }

  private async cancelCleanupAsync(): Promise<void> {
    if (!this._jobId) return;
    this.statusText = "Cancelling cleanup…";
    const result = await hostApi.cancelJobAsync({ JobId: this._jobId });
    if (!result.ok) {
      this.errorMessage = `Failed to cancel: ${result.error}`;
    }
    this.requestUpdate();
  }

  private async RemoveUnusedAsync(): Promise<void> {
    if (!this.report || this.report.Unused.length === 0 || this.isRemoving) return;
    const confirm = await hostApi.showConfirmationAsync({
      Message: `Remove ${this.report.Unused.length} unused package${this.report.Unused.length !== 1 ? "s" : ""}?`,
      Detail: [
        "A timestamped backup of each Directory.Packages.props will be created.",
        ...this.report.Unused.slice(0, 20),
      ].join("\n"),
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.isRemoving = true;
    this.statusText = "";
    this.requestUpdate();
    try {
      const result = await runCleanupJobAsync({}, {
        onStarted: (jobId) => {
          this._jobId = jobId;
          this.requestUpdate();
        },
      });
      if (!result.ok) {
        if (/cancelled/i.test(result.error)) {
          this.statusText = result.error;
        } else {
          this.errorMessage = result.error;
        }
        return;
      }
      const { Removed, Errors, Backups } = result.value;
      const packageWord = Removed.length === 1 ? "package" : "packages";
      const backupWord = Backups.length === 1 ? "backup" : "backups";
      this.statusText = Removed.length > 0
        ? `Removed ${Removed.length} unused ${packageWord}. ${Backups.length} ${backupWord} created.`
        : "No unused packages were removed.";
      if (Errors.length > 0) {
        this.errorMessage = Errors.join("\n");
      }
      await this.LoadCleanupReportAsync();
      this.dispatchEvent(new CustomEvent("cleanup-completed", { bubbles: true, composed: true }));
    } finally {
      this._jobId = "";
      this.isRemoving = false;
      this.requestUpdate();
    }
  }

  private async cancelAddAsync(): Promise<void> {
    if (!this._addJobId) return;
    this.statusText = "Cancelling add…";
    const result = await hostApi.cancelJobAsync({ JobId: this._addJobId });
    if (!result.ok) {
      this.errorMessage = `Failed to cancel: ${result.error}`;
    }
    this.requestUpdate();
  }

  private async AddDefinitionsAsync(entries: MissingDefinition[]): Promise<void> {
    if (this.isAdding || this.isRemoving || entries.length === 0) return;
    const actionable = entries.filter((entry) => entry.Actionable);
    if (actionable.length === 0) return;

    const versions = actionable.map((entry) => `${entry.Id} → v${entry.Version}`);
    const files = [...new Set(actionable.flatMap((entry) => entry.PropsFiles))];
    const confirm = await hostApi.showConfirmationAsync({
      Message: `Add ${actionable.length} PackageVersion ${actionable.length === 1 ? "definition" : "definitions"}?`,
      Detail: [
        "A timestamped backup of each file will be created and the affected projects restored.",
        ...versions,
        ...files,
      ].join("\n"),
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.isAdding = true;
    this.statusText = "";
    this.errorMessage = "";
    this.requestUpdate();
    try {
      const result = await runAddMissingDefinitionsJobAsync(
        { PackageIds: actionable.map((entry) => entry.Id) },
        { onStarted: (jobId) => { this._addJobId = jobId; this.requestUpdate(); } }
      );
      if (!result.ok) {
        if (/cancelled/i.test(result.error)) {
          this.statusText = result.error;
        } else {
          this.errorMessage = result.error;
        }
        return;
      }
      const { Added, Backups, Skipped } = result.value;
      const definitionWord = Added.length === 1 ? "definition" : "definitions";
      const backupWord = Backups.length === 1 ? "backup" : "backups";
      if (Added.length > 0) {
        this.statusText =
          `Added ${Added.length} ${definitionWord}. ${Backups.length} ${backupWord} created.` +
          (Skipped.length > 0 ? ` ${Skipped.length} skipped.` : "");
      } else {
        this.statusText = "No definitions were added.";
      }
      await this.LoadCleanupReportAsync();
      this.dispatchEvent(new CustomEvent("cleanup-completed", { bubbles: true, composed: true }));
    } finally {
      this._addJobId = "";
      this.isAdding = false;
      this.requestUpdate();
    }
  }

  private missingReasonText(entry: MissingDefinition): string {
    switch (entry.Reason) {
      case "noVersion": return "No version found — add it manually";
      case "multipleVersions": return "Projects use different versions — consolidate first";
      case "noPropsFile": return "No Directory.Packages.props governs this project";
      case "conditionalReference": return "Conditional reference — add a conditional PackageVersion manually";
      case "propertyVersion": return "Version comes from an MSBuild property — move it manually";
      case "pinnedVersion": return "Pinned version — add it manually";
      case "unreadableProject": return "Could not read the project file — add it manually";
      case "nonCpmOnly": return "Used without CPM — no definition needed";
      default: return "Cannot add automatically";
    }
  }

  /** Row tooltip: the reason (when not actionable) plus every project path that uses the package. */
  private missingTooltip(entry: MissingDefinition): string {
    const parts: string[] = [];
    if (!entry.Actionable) parts.push(this.missingReasonText(entry));
    if (entry.Projects.length > 0) parts.push(entry.Projects.join("\n"));
    return parts.join("\n");
  }

  private filesLabel(count: number): string {
    return `${count} file${count === 1 ? "" : "s"}`;
  }

  /** Visible project label: first using project's file name plus a "+N" hint for the rest. */
  private projectLabel(projects: string[]): string {
    const first = this.fileName(projects[0] ?? "");
    return projects.length > 1 ? `${first} +${projects.length - 1}` : first;
  }

  private fileName(filePath: string): string {
    return filePath.split(/[\\/]/).pop() ?? filePath;
  }

  override render(): unknown {
    const report = this.report;
    const unused = report?.Unused ?? [];
    const actionableMissing = report?.Missing.filter((entry) => entry.Actionable) ?? [];
    const propsWithUnused = report?.PropsFiles.filter((file) => file.Unused.length > 0) ?? [];

    return html`
      <div class="cleanup-container" aria-busy=${this.isLoading || this.isRemoving || this.isAdding}>
        <div class="list-header">
          <div>
            <div class="list-title">Cleanup unused packages</div>
            <div class="list-subtitle">
              Remove unused <code>PackageVersion</code> entries and direct references that are already transitive
              ${this.statusText ? html` · ${this.statusText}` : nothing}
            </div>
          </div>
          <div class="list-actions">
            <button class="ghost-btn" ?disabled=${this.isLoading || this.isRemoving || this.isAdding} @click=${async () => await this.RefreshAsync()}>
              Refresh
            </button>
            ${this.isRemoving
              ? html`
                  <button class="ghost-btn" ?disabled=${!this._jobId} @click=${async () => await this.cancelCleanupAsync()}>
                    Cancel
                  </button>
                `
              : nothing}
            ${this.isAdding
              ? html`
                  <button class="ghost-btn" ?disabled=${!this._addJobId} @click=${async () => await this.cancelAddAsync()}>
                    Cancel
                  </button>
                `
              : nothing}
            <button class="primary-btn" ?disabled=${this.isLoading || this.isRemoving || this.isAdding || actionableMissing.length === 0} @click=${async () => await this.AddDefinitionsAsync(actionableMissing)}>
              Add definitions${actionableMissing.length > 0 ? ` (${actionableMissing.length})` : ""}
            </button>
            <button class="primary-btn" ?disabled=${this.isLoading || this.isRemoving || this.isAdding || unused.length === 0} @click=${async () => await this.RemoveUnusedAsync()}>
              Remove unused${unused.length > 0 ? ` (${unused.length})` : ""}
            </button>
          </div>
        </div>

        <div class="cleanup-body">
          <dependency-issues
            .projectPaths=${this.projectPaths}
            @dependency-count-changed=${async (e: CustomEvent<number>) => await this.onDependencyCountChangedAsync(e)}
            @project-updated=${async () => {
              await this.LoadCleanupReportAsync();
              this.dispatchEvent(new CustomEvent("cleanup-completed", { bubbles: true, composed: true }));
            }}
          ></dependency-issues>

          ${report
            ? html`<div class="stat-grid">
                <div class="stat"><b>${report.PropsFiles.reduce((n, f) => n + f.Defined.length, 0)}</b><span>defined entries</span></div>
                <div class="stat"><b>${report.Used.length}</b><span>used packages</span></div>
                <div class="stat"><b>${unused.length}</b><span>unused packages</span></div>
                <div class="stat"><b>${report.Missing.length}</b><span>missing definitions</span></div>
              </div>`
            : nothing}

          ${this.isLoading
            ? html`<div class="loading" role="status"><span class="spinner large"></span><span>Scanning package usage...</span></div>`
            : nothing}
          ${this.errorMessage
            ? html`<div class="error" role="alert"><span class="codicon codicon-error"></span><div class="empty-title">Cleanup failed</div><div class="empty-hint">${this.errorMessage}</div></div>`
            : nothing}
          ${!this.isLoading && report && unused.length === 0
            ? html`<div class="empty"><span class="codicon codicon-check"></span><div class="empty-title">No unused packages</div><div class="empty-hint">Every PackageVersion entry is referenced by at least one project.</div></div>`
            : nothing}

          ${!this.isLoading && propsWithUnused.length > 0
            ? html`<div class="package-list">
                ${propsWithUnused.map((file) => html`
                  <div class="group-header">
                    ${this.fileName(file.Path)}
                    <span class="group-count">${file.Unused.length}</span>
                  </div>
                  ${file.Unused.map((packageId) => html`
                    <div class="unused-row">
                      <span class="codicon codicon-package"></span>
                      <span class="package-id" title=${packageId}>${packageId}</span>
                      <span class="file-name" title=${file.Path}>${this.fileName(file.Path)}</span>
                    </div>
                  `)}
                `)}
              </div>`
            : nothing}

          ${report && report.Missing.length > 0
            ? html`<div class="missing-card">
                <div class="missing-title">Used but not defined (${report.Missing.length})</div>
                <div class="missing-hint">These package references are not covered by Directory.Packages.props.</div>
                ${report.Missing.map((entry) => html`
                  <div class="missing-row" title=${this.missingTooltip(entry)}>
                    <span class="codicon codicon-package"></span>
                    <span class="missing-id" title=${entry.Id}>${entry.Id}</span>
                    <span class="missing-version ${entry.Actionable ? "" : "missing-reason"}" title=${entry.Actionable ? entry.Version : this.missingReasonText(entry)}>
                      ${entry.Actionable ? `v${entry.Version}` : this.missingReasonText(entry)}
                    </span>
                    ${entry.Projects.length > 0
                      ? html`<span class="project-name" title=${entry.Projects.join("\n")}>
                          ${this.projectLabel(entry.Projects)}
                        </span>`
                      : nothing}
                    ${entry.PropsFiles.length > 0
                      ? html`<span class="file-name" title=${entry.PropsFiles.join("\n")}>
                          ${this.filesLabel(entry.PropsFiles.length)}
                        </span>`
                      : nothing}
                    ${entry.Actionable
                      ? html`<button class="ghost-btn" ?disabled=${this.isAdding || this.isRemoving} @click=${async () => await this.AddDefinitionsAsync([entry])}>Add</button>`
                      : nothing}
                  </div>
                `)}
              </div>`
            : nothing}
        </div>
      </div>
    `;
  }
}
