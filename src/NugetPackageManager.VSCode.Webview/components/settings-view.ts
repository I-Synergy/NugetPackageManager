import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";

import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { hostApi, configuration, router } from "../registrations";
import { SourceViewModel } from "../types";
import type { ToolchainHealth } from "@/common/rpc/types";
import { CopyToolchainDiagnosticsAsync } from "@/web/utilities/diagnostics";
import "./sdk-select";

@customElement("settings-view")
export class SettingsView extends LitElement {
  @state() private copyFeedback = "";
  @state() private toolchainRefresh = 0;

  private readonly _toolchainTask = new Task(this, {
    task: async ([refreshToken], { signal }): Promise<ToolchainHealth | null> => {
      const result = await hostApi.getToolchainHealthAsync(
        { ForceRefresh: refreshToken > 0 },
        signal
      );
      return result.ok ? result.value.Health : null;
    },
    args: () => [this.toolchainRefresh] as const,
  });
  static override readonly styles = [
    codicon,
    scrollableBase,
    css`
      .container {
        display: flex;
        flex-direction: column;
        height: 100%;
        .header {
          margin-bottom: 8px;
          .return-btn {
            display: flex;
            gap: 4px;
            align-items: center;
            span {
              font: 17px / 1 codicon;
            }
          }
        }
        .sections-container {
          width: 100%;
          max-width: 700px;
          align-self: center;
          overflow-y: auto;

          .section {
            margin-right: 20px;
            margin-bottom: 12px;

            .text-field {
              width: 100%;
            }
            .title {
              font-weight: bold;
              font-size: 13px;
              margin-bottom: 6px;
            }
            .subtitle {
              margin-bottom: 8px;
            }
          }

          .sources-section {
            .sources-editor {
              .row {
                margin: 4px 0px;
                display: grid;
                grid-template-columns: 20% 35% 45%;
                grid-column-gap: 10px;
                &.data-row {
                  .actions {
                    display: none;
                  }
                  .label {
                    padding: 4px 2px;
                    text-wrap: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                  }
                  &:hover {
                    grid-template-columns: 20% 25% 30% 50px;
                    background-color: var(--vscode-list-hoverBackground);
                    &:not(:first-child) {
                      .actions {
                        display: flex;
                        gap: 2px;
                      }
                    }
                  }
                }
                &.edit-row {
                  grid-template-columns: 20% 25% 30% 108px;
                }
              }
            }
            .add-source {
              margin: 6px 0px;
            }
          }
        }
      }

      button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 4px 12px;
        cursor: pointer;
      }

      button.icon-btn {
        background: transparent;
        border: none;
        color: var(--vscode-icon-foreground);
        cursor: pointer;
        padding: 2px;
      }

      button.secondary-btn {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      input[type="text"] {
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        padding: 4px 8px;
        width: 100%;
        box-sizing: border-box;
      }
    `,
  ];

  @state() private skipRestore: boolean = false;
  @state() private enablePackageVersionInlineInfo: boolean = false;
  @state() private allowMajorVersionOverride: boolean = false;
  @state() private newSource: SourceViewModel | null = null;
  @state() private sources: SourceViewModel[] = [];

  override connectedCallback(): void {
    super.connectedCallback();
    const config = configuration.Configuration;
    this.skipRestore = config?.SkipRestore ?? false;
    this.enablePackageVersionInlineInfo = config?.EnablePackageVersionInlineInfo ?? false;
    this.allowMajorVersionOverride = config?.AllowMajorVersionOverride ?? false;
    this.sources = config?.Sources.map((x) => new SourceViewModel(x)) ?? [];
  }

  private async updateConfigurationAsync(): Promise<void> {
    const sources = this.sources.map((x) => x.GetModel());
    configuration.UpdateLocal({
      SkipRestore: this.skipRestore,
      EnablePackageVersionInlineInfo: this.enablePackageVersionInlineInfo,
      Sources: sources,
      AllowMajorVersionOverride: this.allowMajorVersionOverride,
    });
    await hostApi.updateConfigurationAsync({
      Configuration: {
        SkipRestore: this.skipRestore,
        EnablePackageVersionInlineInfo: this.enablePackageVersionInlineInfo,
        Prerelease: configuration.Configuration?.Prerelease ?? false,
        Sources: sources,
        StatusBarLoadingIndicator:
          configuration.Configuration?.StatusBarLoadingIndicator ?? false,
        AllowMajorVersionOverride: this.allowMajorVersionOverride,
      },
    });
  }

  private addSourceRow(): void {
    this.sources.filter((x) => x.EditMode).forEach((x) => x.Cancel());
    this.newSource = new SourceViewModel();
    this.newSource.Edit();
    this.sources = [...this.sources, this.newSource];
  }

  private editRow(source: SourceViewModel): void {
    this.sources.filter((x) => x.EditMode).forEach((x) => x.Cancel());
    source.Edit();
    this.requestUpdate();
  }

  private async removeRowAsync(source: SourceViewModel): Promise<void> {
    const confirm = await hostApi.showConfirmationAsync({
      Message: `Remove source "${source.Name}"?`,
      Detail: `This will remove the NuGet source "${source.Name}" (${source.Url}).`,
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.sources = this.sources.filter((s) => s !== source);
    await this.updateConfigurationAsync();
  }

  private async saveRowAsync(source: SourceViewModel): Promise<void> {
    if (this.newSource?.Id === source.Id) this.newSource = null;
    source.Save();
    if (source.Name === "" && source.Url === "") {
      await this.removeRowAsync(source);
      return;
    }
    this.requestUpdate();
    await this.updateConfigurationAsync();
  }

  private async cancelRowAsync(source: SourceViewModel): Promise<void> {
    if (this.newSource?.Id === source.Id) this.newSource = null;
    if (source.Name === "" && source.Url === "") {
      await this.removeRowAsync(source);
    } else {
      source.Cancel();
      this.requestUpdate();
    }
  }

  private renderSourceRow(source: SourceViewModel): unknown {
    if (source.EditMode) {
      return html`
        <div class="row edit-row">
          <input
            type="text"
            placeholder="Name"
            .value=${source.DraftName}
            @input=${(e: Event) => {
              source.DraftName = (e.target as HTMLInputElement).value;
            }}
          />
          <input
            type="text"
            placeholder="Url"
            .value=${source.DraftUrl}
            @input=${(e: Event) => {
              source.DraftUrl = (e.target as HTMLInputElement).value;
            }}
          />
          <input
            type="text"
            placeholder="Password Script Path (optional)"
            .value=${source.DraftPasswordScriptPath}
            @input=${(e: Event) => {
              source.DraftPasswordScriptPath = (e.target as HTMLInputElement).value;
            }}
          />
          <div>
            <button @click=${async () => { await this.saveRowAsync(source); }}>Ok</button>
            <button class="secondary-btn" @click=${async () => { await this.cancelRowAsync(source); }}>Cancel</button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="row data-row">
        <span class="label">${source.Name}</span>
        <span class="label">${source.Url}</span>
        <span class="label">${source.PasswordScriptPath}</span>
        <div class="actions">
          <button class="icon-btn" aria-label="Edit source" title="Edit" @click=${() => this.editRow(source)}>
            <span class="codicon codicon-edit"></span>
          </button>
          <button class="icon-btn" aria-label="Remove source" title="Remove" @click=${async () => { await this.removeRowAsync(source); }}>
            <span class="codicon codicon-close"></span>
          </button>
        </div>
      </div>
    `;
  }

  private renderSdkSelect(): unknown {
    const health = this._toolchainTask.value;
    if (!health) return nothing;
    const candidates = [health.PinnedSdkVersion].filter(
      (version): version is string => Boolean(version)
    );
    const recommended = candidates.find(
      (version) => !health.InstalledSdks.some((sdk) => sdk.Version === version)
    ) ?? "";
    return html`
      <sdk-select
        .sdks=${health.InstalledSdks}
        .selected=${health.PinnedSdkVersion ?? ""}
        .recommended=${recommended}
        @sdk-changed=${() => { this.toolchainRefresh += 1; }}
      ></sdk-select>
    `;
  }

  private renderToolchainStatus(): unknown {
    if (this._toolchainTask.status === TaskStatus.PENDING) return "Checking the .NET SDK…";
    if (this._toolchainTask.status === TaskStatus.ERROR) return "Could not check the .NET SDK.";
    const health = this._toolchainTask.value;
    if (!health) return "Could not check the .NET SDK.";
    if (!health.DotnetFound) return "dotnet was not found on PATH.";
    const pin = health.PinnedSdkVersion ? ` · global.json pins ${health.PinnedSdkVersion}` : " · no global.json pin";
    const issueCount = health.Issues.length;
    const plural = issueCount === 1 ? "" : "s";
    const problems = issueCount === 0 ? "no problems detected" : `${issueCount} problem${plural}`;
    return `SDK ${health.SdkVersion ?? "unknown"}${pin} · ${problems}`;
  }

  private async copyDiagnosticsAsync(): Promise<void> {
    this.copyFeedback = await CopyToolchainDiagnosticsAsync([], "Diagnostics copied (credentials redacted).");
  }

  override render(): unknown {
    return html`
      <div class="container">
        <div class="header">
          <button class="icon-btn" aria-label="Go back" @click=${() => router.Navigate("BROWSE")}>
            <div class="return-btn">
              <span class="codicon codicon-arrow-left"></span>BACK
            </div>
          </button>
        </div>

        <div class="sections-container">
          <div class="section">
            <label class="title">
              <input
                type="checkbox"
                .checked=${this.skipRestore}
                @change=${async (e: Event) => {
                  this.skipRestore = (e.target as HTMLInputElement).checked;
                  await this.updateConfigurationAsync();
                }}
              />
              Skip performing a restore preview and compatibility check
            </label>
          </div>

          <div class="section">
            <label class="title">
              <input
                type="checkbox"
                .checked=${this.enablePackageVersionInlineInfo}
                @change=${async (e: Event) => {
                  this.enablePackageVersionInlineInfo = (e.target as HTMLInputElement).checked;
                  await this.updateConfigurationAsync();
                }}
              />
              Show inline information about newer package versions in project files
            </label>
          </div>

          <div class="section">
            <label class="title">
              <input
                type="checkbox"
                .checked=${this.allowMajorVersionOverride}
                @change=${async (e: Event) => {
                  this.allowMajorVersionOverride = (e.target as HTMLInputElement).checked;
                  await this.updateConfigurationAsync();
                }}
              />
              Allow framework-aligned packages to cross their target framework's major version
            </label>
            <div class="subtitle">Only applies when the workspace targets more than one .NET major.</div>
          </div>

          <div class="section">
            <div class="title">dotnet toolchain</div>
            <div class="subtitle">${this.renderToolchainStatus()}</div>
            ${this.renderSdkSelect()}
            <button class="add-source" aria-label="Copy dotnet toolchain diagnostics" @click=${async () => await this.copyDiagnosticsAsync()}>
              Copy diagnostics
            </button>
            ${this.copyFeedback ? html`<div class="subtitle" role="status">${this.copyFeedback}</div>` : nothing}
          </div>

          <div class="section sources-section">
            <div class="title">Sources</div>
            <div class="subtitle">NuGet sources</div>
            <div class="sources-editor">
              ${this.sources.map((source) => this.renderSourceRow(source))}
            </div>
            ${this.newSource === null
              ? html`
                  <button class="add-source" aria-label="Add new source" @click=${() => this.addSourceRow()}>
                    Add source
                  </button>
                `
              : nothing}
          </div>
        </div>
      </div>
    `;
  }
}
