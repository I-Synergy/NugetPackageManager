import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import codicon from "@/web/styles/codicon.css";
import { hostApi } from "@/web/registrations";
import type { DotnetFailureInfo, RestoreConflictInfo } from "@/common/rpc/types";

/**
 * Shows a failed package operation as cause + remedy instead of a wall of
 * MSBuild output. The raw output stays available behind "Show output", and
 * "Copy diagnostics" pulls the redacted toolchain report from the host.
 */
@customElement("actionable-error")
export class ActionableError extends LitElement {
  static override readonly styles = [
    codicon,
    css`
      :host {
        display: block;
        margin: 6px 8px;
      }

      .card {
        border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
        background: var(--vscode-inputValidation-errorBackground, transparent);
        border-radius: var(--npm-radius, 8px);
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .head {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        color: var(--vscode-errorForeground);
        min-width: 0;
      }

      .title {
        overflow-wrap: anywhere;
      }

      .summary {
        color: var(--vscode-foreground);
        overflow-wrap: anywhere;
      }

      .hint {
        color: var(--vscode-descriptionForeground);
        font-size: 0.95em;
        overflow-wrap: anywhere;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
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

      .feedback {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
      }

      .conflicts {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .conflict-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      pre {
        margin: 0;
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
    `,
  ];

  /** Classified failure from the host. */
  @property({ attribute: false }) failure?: DotnetFailureInfo;
  /** Heading; defaults to a generic failure label. */
  @property({ type: String }) heading = "Operation failed";
  /** Shows a "Retry" button that dispatches `retry`. */
  @property({ type: Boolean }) canRetry = false;

  @state() private expanded = false;
  @state() private feedback = "";
  @state() private conflictBusy = false;
  @state() private conflictFeedback = "";

  private onRetry(): void {
    this.dispatchEvent(new CustomEvent("retry", { bubbles: true, composed: true }));
  }

  private outputLabel(): string {
    return this.expanded ? "Hide output" : "Show output";
  }

  private onShowOutput(): void {
    this.expanded = !this.expanded;
  }

  /** Links referenced by the failure (advisories, docs), capped for the card. */
  private get referenceLinks(): Array<{ Url: string; Label: string }> {
    const failure = this.failure;
    if (!failure) return [];
    const text = `${failure.Summary}
${failure.Hint}
${failure.Detail}`;
    const urls = [...text.matchAll(/https?:\/\/[^\s)"']+/g)]
      .map((match) => match[0].replace(/[.,;]+$/, ""))
      .filter((url) => !url.includes("aka.ms"));
    return [...new Set(urls)]
      .slice(0, 3)
      .map((url) => ({ Url: url, Label: url.includes("/advisories/") ? "Open advisory" : "Open link" }));
  }

  private async openUrlAsync(url: string): Promise<void> {
    await hostApi.openUrlAsync({ Url: url });
  }

  private get fixableConflicts(): RestoreConflictInfo[] {
    const projectPath = this.failure?.ProjectPath;
    if (!projectPath) return [];
    return (this.failure?.Conflicts ?? []).filter(
      (conflict) => Boolean(conflict.PackageId && conflict.SuggestedVersion)
    );
  }

  /**
   * Applies the version NuGet suggested for one conflict (props group for CPM,
   * `PackageReference` otherwise) and restores through the host.
   */
  private async pinConflictAsync(conflict: RestoreConflictInfo): Promise<void> {
    const projectPath = this.failure?.ProjectPath;
    if (!projectPath || !conflict.PackageId || !conflict.SuggestedVersion) return;

    this.conflictBusy = true;
    this.conflictFeedback = "";
    const result = await hostApi.fixRestoreConflictAsync({
      ProjectPath: projectPath,
      PackageId: conflict.PackageId,
      Version: conflict.SuggestedVersion,
    });
    this.conflictBusy = false;

    if (!result.ok) {
      this.conflictFeedback = `Could not apply the fix: ${result.error}`;
      return;
    }
    if (result.value.RestoreError) {
      this.conflictFeedback = `Pinned ${conflict.PackageId} to ${conflict.SuggestedVersion}, but restore still fails: ${result.value.RestoreError}`;
      return;
    }

    this.conflictFeedback = `Pinned ${conflict.PackageId} to ${conflict.SuggestedVersion} and restored successfully.`;
    this.dispatchEvent(new CustomEvent("restored", { bubbles: true, composed: true }));
  }

  private async onCopyDiagnosticsAsync(): Promise<void> {
    const projectPaths = this.failure?.ProjectPath ? [this.failure.ProjectPath] : [];
    const result = await hostApi.runToolchainDiagnosticsAsync({ ProjectPaths: projectPaths });
    if (!result.ok) {
      this.feedback = "Could not collect diagnostics.";
      return;
    }
    const copied = await this.copyToClipboardAsync(result.value.Report);
    this.feedback = copied ? "Diagnostics copied." : "Copy failed — see the output channel.";
  }

  private async copyToClipboardAsync(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  override render(): unknown {
    const failure = this.failure;
    if (!failure) return nothing;

    return html`
      <div class="card" role="alert">
        <div class="head">
          <span class="codicon codicon-error"></span>
          <span class="title">${this.heading}</span>
        </div>
        <div class="summary">${failure.Summary}</div>
        <div class="hint">${failure.Hint}</div>
        ${this.fixableConflicts.length > 0
          ? html`
              <div class="conflicts">
                ${this.fixableConflicts.map(
                  (conflict) => html`
                    <div class="conflict-actions">
                      <button
                        ?disabled=${this.conflictBusy}
                        @click=${async () => await this.pinConflictAsync(conflict)}
                      >Pin ${conflict.PackageId} to ${conflict.SuggestedVersion}</button>
                    </div>
                  `
                )}
                ${this.conflictFeedback
                  ? html`<span class="feedback" role="status">${this.conflictFeedback}</span>`
                  : nothing}
              </div>
            `
          : nothing}
        <div class="actions">
          ${this.canRetry ? html`<button @click=${this.onRetry}>Retry</button>` : nothing}
          <button @click=${async () => await this.onCopyDiagnosticsAsync()}>Copy diagnostics</button>
          ${this.referenceLinks.map(
            (link) => html`<button @click=${async () => await this.openUrlAsync(link.Url)}>${link.Label}</button>`
          )}
          ${failure.Detail
            ? html`<button @click=${this.onShowOutput}>${this.outputLabel()}</button>`
            : nothing}
          ${this.feedback ? html`<span class="feedback" role="status">${this.feedback}</span>` : nothing}
        </div>
        ${this.expanded && failure.Detail ? html`<pre>${failure.Detail}</pre>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "actionable-error": ActionableError;
  }
}
