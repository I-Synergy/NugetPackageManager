import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";
import codicon from "@/web/styles/codicon.css";
import { hostApi } from "@/web/registrations";
import { runProjectUpdateJobAsync } from "@/web/jobs";
import type { DependencyIssue } from "@/common/rpc/types";
import "./dropdown";

/**
 * Direct references that the dependency graph already provides transitively.
 *
 * Removing one is safe only when it does not lower a version, so `Pinned` rows
 * (the direct reference deliberately raises the version) are listed but never
 * removable. Removal goes through the normal project-update job, so files are
 * snapshotted, restored and rolled back like any other package operation.
 */
/** Restoring more than this in one RPC would exceed the client deadline. */
const MAX_AUTO_RESTORE = 20;

@customElement("dependency-issues")
export class DependencyIssues extends LitElement {
  static override readonly styles = [
    codicon,
    css`
      :host {
        display: block;
        margin: 6px 8px 0;
      }

      .card {
        border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
        border-radius: var(--npm-radius, 10px);
        background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
        padding: 8px 10px;
      }

      .header {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        background: none;
        border: none;
        color: var(--vscode-foreground);
        font: inherit;
        cursor: pointer;
        padding: 2px 0;
        text-align: left;
      }

      .header:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
      }

      .count {
        color: var(--vscode-descriptionForeground);
      }

      .spacer {
        flex: 1;
      }

      .issue {
        display: grid;
        grid-template-columns: minmax(0, 1fr) max-content;
        gap: 4px 10px;
        align-items: center;
        padding: 6px 0;
        border-top: 1px solid var(--npm-border, var(--vscode-panelSection-border));
      }

      .package {
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .chain {
        grid-column: 1;
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        overflow-wrap: anywhere;
      }

      .badge {
        display: inline-block;
        margin-left: 6px;
        padding: 0 5px;
        border-radius: 8px;
        font-size: 0.8em;
        font-weight: 400;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }

      .badge.pinned {
        background: var(--vscode-inputValidation-warningBackground, transparent);
        color: var(--vscode-foreground);
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

      button:hover:not(:disabled) {
        background: var(--vscode-button-secondaryHoverBackground);
      }

      button:disabled {
        opacity: 0.5;
        cursor: default;
      }

      button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }

      .feedback {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        overflow-wrap: anywhere;
      }
    `,
  ];

  @property({ attribute: false }) projectPaths: string[] = [];

  @state() private expanded = false;
  @state() private issues: DependencyIssue[] = [];
  @state() private skipped = 0;
  @state() private skippedPaths: string[] = [];
  @state() private restoring: string[] = [];
  @state() private restoreError = "";
  @state() private busy = false;
  @state() private feedback = "";
  @state() private reloadToken = 0;
  /** The automatic restore runs once per mounted section, never in a loop. */
  private autoRestoreAttempted = false;

  private readonly _loadTask = new Task(this, {
    args: () => [this.projectPaths.join("\n"), this.reloadToken] as const,
    task: async ([paths], { signal }) => {
      const projectPaths = paths ? paths.split("\n") : [];
      const first = await hostApi.getDependencyIssuesAsync({ ProjectPaths: projectPaths }, signal);
      if (!first.ok) throw new Error(first.error);

      let result = first.value;
      this.skippedPaths = result.SkippedProjectPaths;

      // Opening the section restores projects that were never restored, so the
      // analysis is complete. It runs once; a failure offers a retry instead of
      // looping.
      if (result.SkippedProjectPaths.length > 0 && !this.autoRestoreAttempted) {
        this.autoRestoreAttempted = true;
        // One RPC can only wait ~2 minutes, so restore a bounded batch and let
        // the retry action continue with the rest.
        const batch = result.SkippedProjectPaths.slice(0, MAX_AUTO_RESTORE);
        this.restoring = batch;
        this.restoreError = "";
        this.requestUpdate();

        const restored = await hostApi.restoreProjectsAsync(
          { ProjectPaths: batch },
          signal
        );
        this.restoring = [];
        if (!restored.ok) {
          this.restoreError = `Restoring ${batch.length} project(s) failed: ${restored.error}`;
        } else {
          const again = await hostApi.getDependencyIssuesAsync({ ProjectPaths: projectPaths }, signal);
          if (again.ok) result = again.value;
        }
        this.requestUpdate();
      }

      this.issues = result.Issues;
      this.skipped = result.ProjectsSkipped;
      this.skippedPaths = result.SkippedProjectPaths;
      if (result.SkippedProjectPaths.length > 0 && this.autoRestoreAttempted && !this.restoreError) {
        this.restoreError = `${result.SkippedProjectPaths.length} project(s) still need a restore — press Restore again.`;
      }
      this.reportCount();
      return result;
    },
  });

  private reportCount(): void {
    this.dispatchEvent(
      new CustomEvent<number>("dependency-count-changed", {
        detail: this.issues.filter((issue) => issue.Kind === "Redundant").length,
        bubbles: true,
        composed: true,
      })
    );
  }

  private get removable(): DependencyIssue[] {
    return this.issues.filter((issue) => issue.Kind === "Redundant");
  }

  private async retryRestoreAsync(): Promise<void> {
    if (this.skippedPaths.length === 0) return;
    this.restoring = this.skippedPaths;
    this.restoreError = "";
    const restored = await hostApi.restoreProjectsAsync({ ProjectPaths: this.skippedPaths });
    this.restoring = [];
    if (!restored.ok) {
      this.restoreError = `Restoring ${this.skippedPaths.length} project(s) failed: ${restored.error}`;
      return;
    }
    this.reloadToken += 1;
  }

  private async removeAsync(issue: DependencyIssue): Promise<void> {
    const confirm = await hostApi.showConfirmationAsync({
      Message: `Remove the direct reference to ${issue.PackageId}?`,
      Detail:
        `${issue.ProjectPath}\n\n${issue.PackageId} ${issue.DirectVersion} also arrives via ${issue.Chain}, ` +
        "so the resolved version does not change.",
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.busy = true;
    const result = await runProjectUpdateJobAsync({
      Type: "UNINSTALL",
      ProjectPath: issue.ProjectPath,
      PackageId: issue.PackageId,
      Version: issue.DirectVersion,
      SourceUrl: "",
    });
    this.busy = false;

    if (!result.ok) {
      this.feedback = `Removing ${issue.PackageId} failed: ${result.error}`;
      return;
    }

    this.issues = this.issues.filter(
      (candidate) =>
        !(candidate.PackageId === issue.PackageId && candidate.ProjectPath === issue.ProjectPath)
    );
    this.feedback = `Removed the direct reference to ${issue.PackageId}.`;
    this.reportCount();
    this.dispatchEvent(new CustomEvent("project-updated", { bubbles: true, composed: true }));
  }

  private async removeAllAsync(): Promise<void> {
    const removable = this.removable;
    if (removable.length === 0) return;

    const confirm = await hostApi.showConfirmationAsync({
      Message: `Remove ${removable.length} redundant direct reference${removable.length === 1 ? "" : "s"}?`,
      Detail:
        "Each package still arrives transitively, so the resolved versions do not change. " +
        "References that pin a higher version are left untouched.",
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.busy = true;
    let removed = 0;
    for (const issue of removable) {
      const result = await runProjectUpdateJobAsync({
        Type: "UNINSTALL",
        ProjectPath: issue.ProjectPath,
        PackageId: issue.PackageId,
        Version: issue.DirectVersion,
        SourceUrl: "",
      });
      if (!result.ok) {
        this.feedback = `Stopped at ${issue.PackageId}: ${result.error}`;
        break;
      }
      removed++;
      this.issues = this.issues.filter(
        (candidate) =>
          !(candidate.PackageId === issue.PackageId && candidate.ProjectPath === issue.ProjectPath)
      );
      this.reportCount();
    }
    this.busy = false;
    if (removed > 0) {
      this.feedback = `Removed ${removed} redundant reference${removed === 1 ? "" : "s"}.`;
      this.dispatchEvent(new CustomEvent("project-updated", { bubbles: true, composed: true }));
    }
  }

  private renderIssue(issue: DependencyIssue): unknown {
    const pinned = issue.Kind === "Pinned";
    return html`
      <div class="issue">
        <div class="package">
          ${issue.PackageId} ${issue.DirectVersion}
          <span class="badge ${pinned ? "pinned" : ""}">${pinned ? "pinned — kept" : "redundant"}</span>
        </div>
        <div>
          ${pinned
            ? nothing
            : html`<button
                ?disabled=${this.busy}
                @click=${async () => await this.removeAsync(issue)}
              >Remove</button>`}
        </div>
        <div class="chain">
          ${pinned ? "Direct reference raises the version above" : "already provided"} via ${issue.Chain}
          ${issue.Tfm ? html` · ${issue.Tfm}` : nothing}
        </div>
      </div>
    `;
  }

  override render(): unknown {
    if (this._loadTask.status === TaskStatus.ERROR) return nothing;

    const restoringCard = this.renderRestoringCard();
    const errorCard = this.renderRestoreErrorCard();
    if (this.issues.length === 0) return html`${restoringCard}${errorCard}`;

    const removable = this.removable.length;
    const pinned = this.issues.length - removable;

    return html`
      ${restoringCard}${errorCard}
      <div class="card">
        ${this.renderHeader(removable, pinned)}
        ${this.renderBody(removable)}
        ${this.renderFeedback()}
        ${this.renderSkippedNote()}
      </div>
    `;
  }

  private renderRestoringCard(): unknown {
    if (this.restoring.length === 0) return nothing;
    const count = this.restoring.length;
    const noun = count === 1 ? "project" : "projects";
    return html`
      <div class="card" role="status">
        <div class="header">
          <span class="codicon codicon-loading codicon-modifier-spin"></span>
          <span>Restoring ${count} ${noun} to complete the analysis…</span>
        </div>
      </div>
    `;
  }

  private renderRestoreErrorCard(): unknown {
    if (!this.restoreError) return nothing;
    return html`
      <div class="card">
        <div class="feedback" role="alert">${this.restoreError}</div>
        <div class="actions">
          <button ?disabled=${this.restoring.length > 0} @click=${async () => await this.retryRestoreAsync()}>
            Restore again
          </button>
        </div>
      </div>
    `;
  }

  private renderHeader(removable: number, pinned: number): unknown {
    const count = this.issues.length;
    const noun = count === 1 ? "direct reference also arrives" : "direct references also arrive";
    const pinnedNote = pinned > 0 ? ` · ${pinned} pinned` : "";
    const chevron = this.expanded ? "codicon-chevron-down" : "codicon-chevron-right";
    return html`
      <button class="header" aria-expanded=${this.expanded} @click=${() => { this.expanded = !this.expanded; }}>
        <span class="codicon ${chevron}"></span>
        <span>${count} ${noun} transitively</span>
        <span class="spacer"></span>
        <span class="count">${removable} removable${pinnedNote}</span>
      </button>
    `;
  }

  private renderBody(removable: number): unknown {
    if (!this.expanded) return nothing;
    return html`
      ${this.issues.map((issue) => this.renderIssue(issue))}
      ${this.renderRemoveAllAction(removable)}
    `;
  }

  private renderRemoveAllAction(removable: number): unknown {
    if (removable === 0) return nothing;
    return html`
      <div class="actions">
        <button ?disabled=${this.busy} @click=${async () => await this.removeAllAsync()}>
          Remove all safe references
        </button>
      </div>
    `;
  }

  private renderFeedback(): unknown {
    if (!this.feedback) return nothing;
    return html`<div class="feedback" role="status">${this.feedback}</div>`;
  }

  private renderSkippedNote(): unknown {
    if (!this.expanded || this.skipped === 0) return nothing;
    const noun = this.skipped === 1 ? "project" : "projects";
    return html`<div class="feedback">${this.skipped} ${noun} not restored yet — restore to include them.</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dependency-issues": DependencyIssues;
  }
}
