import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";
import codicon from "@/web/styles/codicon.css";
import { hostApi } from "@/web/registrations";
import { CopyToolchainDiagnosticsAsync } from "@/web/utilities/diagnostics";
import { RecommendedSdkVersion } from "@/web/utilities/toolchain";
import "./sdk-select";

/**
 * Warns when the .NET toolchain cannot serve this workspace — a selected SDK
 * that ignores `global.json`, a missing pinned SDK, or workload manifests that
 * fail SDK resolution. The check runs a real `dotnet msbuild -getProperty`
 * evaluation in the project's SDK context, so it fails for the same reasons a
 * restore would, before the user starts one.
 */
@customElement("toolchain-banner")
export class ToolchainBanner extends LitElement {
  static override readonly styles = [
    codicon,
    css`
      :host {
        display: block;
      }

      .banner {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin: 6px 8px 0;
        padding: 8px 12px;
        border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
        background: var(--vscode-inputValidation-warningBackground, transparent);
        border-radius: var(--npm-radius, 8px);
      }

      .icon {
        color: var(--vscode-editorWarning-foreground);
        margin-top: 1px;
      }

      .body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .banner-title {
        font-weight: 600;
      }

      .issue-summary {
        overflow-wrap: anywhere;
      }

      .issue-hint {
        color: var(--vscode-descriptionForeground);
        font-size: 0.95em;
        margin-bottom: 2px;
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

      button:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .progress-track {
        height: 3px;
        width: 100%;
        border-radius: 2px;
        overflow: hidden;
        background: color-mix(in srgb, var(--vscode-progressBar-background) 30%, transparent);
      }

      .progress-fill {
        height: 100%;
        width: 35%;
        border-radius: 2px;
        background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
        animation: npm-banner-indeterminate 1.2s ease-in-out infinite;
      }

      @keyframes npm-banner-indeterminate {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(300%);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .progress-fill {
          animation: none;
          width: 100%;
          opacity: 0.6;
        }
      }
    `,
  ];

  /** Projects the check runs against; the first is used for the smoke evaluation. */
  @property({ attribute: false }) projectPaths: string[] = [];

  @state() private refreshToken = 0;
  @state() private dismissed = false;
  @state() private feedback = "";

  private readonly _healthTask = new Task(this, {
    args: () => [this.refreshToken, this.projectPaths.join("|")] as const,
    task: async ([refreshToken, paths], { signal }) => {
      const projectPaths = paths ? paths.split("|") : [];
      const result = await hostApi.getToolchainHealthAsync(
        { ProjectPaths: projectPaths, ForceRefresh: refreshToken > 0 },
        signal
      );
      if (!result.ok) throw new Error(result.error);
      return result.value.Health;
    },
  });

  /** The tab owns the repair actions and the full report. */
  private onOpenToolchain(): void {
    this.dispatchEvent(new CustomEvent("open-toolchain", { bubbles: true, composed: true }));
  }

  private onRecheck(): void {
    this.refreshToken += 1;
    this.feedback = "";
  }

  private async onCopyDiagnosticsAsync(): Promise<void> {
    this.feedback = await CopyToolchainDiagnosticsAsync(this.projectPaths, "Diagnostics copied.");
  }

  override render(): unknown {
    if (this.dismissed) return nothing;

    const health = this._healthTask.value;
    const isChecking = this._healthTask.status === TaskStatus.PENDING;
    // Keep the banner (and its previous issues) visible while a re-check runs,
    // so pressing Re-check shows progress instead of hiding the panel.
    if (!health || (health.Issues.length === 0 && !isChecking)) return nothing;

    return html`
      <div class="banner" role="alert" aria-live="polite">
        <span class="codicon codicon-warning icon"></span>
        <div class="body">
          <div class="banner-title">dotnet toolchain problem</div>
          ${health.Issues.map(
            (issue) => html`
              <div class="issue-summary">${issue.Summary}</div>
              <div class="issue-hint">${issue.Hint}</div>
            `
          )}
          ${this.feedback ? html`<div class="feedback" role="status">${this.feedback}</div>` : nothing}
          ${isChecking
            ? html`<div class="progress-track" role="progressbar" aria-label="Checking the .NET SDK" aria-valuetext="Checking">
                <div class="progress-fill"></div>
              </div>`
            : nothing}
          <div class="actions">
            <sdk-select
              .sdks=${health.InstalledSdks}
              .selected=${health.PinnedSdkVersion ?? ""}
              .projectPaths=${this.projectPaths}
              .recommended=${RecommendedSdkVersion(health)}
              @sdk-changed=${this.onRecheck}
            ></sdk-select>
            <button @click=${this.onOpenToolchain}>Open Toolchain</button>
            <button ?disabled=${isChecking} @click=${this.onRecheck}>Re-check</button>
            <button @click=${async () => await this.onCopyDiagnosticsAsync()}>Copy diagnostics</button>
            <button @click=${() => { this.dismissed = true; }}>Dismiss</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "toolchain-banner": ToolchainBanner;
  }
}
