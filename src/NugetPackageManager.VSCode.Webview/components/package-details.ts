import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";
import type { GetPackageDetailsRequest, GetPackageFrameworksRequest } from "@/common/rpc/types";
import { PackageViewModel } from "../types";
import { FormatDownloads, IsPrereleaseVersion } from "@/common/package-display";
import codicon from "@/web/styles/codicon.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "../registrations";

type DetailTab = "description" | "dependencies" | "frameworks" | "versions";

@customElement("package-details")
export class PackageDetailsComponent extends LitElement {
  static override readonly styles = [
    codicon,
    sharedStyles,
    css`
      .loader {
        margin: 0px auto;
      }

      .detail-tabs {
        display: flex;
        border-bottom: 1px solid var(--vscode-panelSection-border);
        margin-bottom: 8px;
      }

      .detail-tab {
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        padding: 4px 10px;
        font-size: 11px;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        opacity: 0.7;
      }

      .detail-tab:hover {
        opacity: 1;
      }

      .detail-tab.active {
        opacity: 1;
        border-bottom-color: var(--vscode-panelTitle-activeBorder);
        color: var(--vscode-panelTitle-activeForeground);
      }

      .tab-content {
        padding: 0 4px;
      }

      .package-meta {
        display: grid;
        gap: 4px 16px;
        grid-template-columns: fit-content(100%) auto;
        font-size: 12px;
        margin-top: 8px;
      }

      .package-meta .label {
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
      }

      .package-meta .value {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .package-meta a {
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
      }

      .package-meta a:hover {
        text-decoration: underline;
      }

      .description-text {
        font-size: 12px;
        line-height: 1.5;
        margin-bottom: 4px;
        color: var(--vscode-foreground);
      }

      .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 8px;
      }

      .tag {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 3px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }

      .dependencies {
        font-size: 12px;

        ul {
          margin: 4px 0px;
          padding-left: 20px;
        }

        li {
          padding: 1px 0;
        }
      }

      .no-dependencies {
        margin-top: 8px;
        display: flex;
        gap: 4px;
        align-items: center;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;

        span {
          vertical-align: middle;
        }
      }

      .error {
        margin-top: 8px;
        display: flex;
        gap: 4px;
        align-items: center;
        color: var(--vscode-errorForeground);
        font-size: 12px;
      }

      .versions-list {
        font-size: 12px;
        max-height: 300px;
        overflow-y: auto;
      }

      .version-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 3px 4px;
        gap: 8px;
      }

      .version-row:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .version-row.current {
        background-color: var(--vscode-list-inactiveSelectionBackground);
      }

      .version-number {
        font-family: var(--vscode-editor-font-family);
      }

      .version-badges {
        display: flex;
        gap: 4px;
        align-items: center;
      }

      .prerelease-badge {
        font-size: 9px;
        padding: 0 4px;
        border-radius: 3px;
        background: var(--vscode-editorWarning-foreground);
        color: var(--vscode-editor-background);
      }

      .installed-badge {
        font-size: 9px;
        padding: 0 4px;
        border-radius: 3px;
        background: var(--vscode-charts-green, #10b981);
        color: var(--vscode-editor-background);
      }

      .frameworks {
        font-size: 12px;
        max-height: 300px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 4px;
      }

      .framework-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .framework-product {
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
      }

      .framework-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .tfm-badge {
        font-size: 10px;
        font-family: var(--vscode-editor-font-family);
        padding: 1px 6px;
        border-radius: 3px;
        border: 1px solid var(--vscode-badge-background);
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }

      /* Computed frameworks are only compatible, not declared by the package. */
      .tfm-badge.is-computed {
        opacity: 0.55;
        background: transparent;
        color: var(--vscode-foreground);
      }
    `,
  ];

  @property({ attribute: false }) package: PackageViewModel | null = null;
  @property() source: string = "";
  @property() passwordScriptPath?: string;
  @property() selectedVersion: string = "";

  @state() packageDetailsLoading: boolean = false;
  @state() packageDetails: PackageDetails | undefined;
  @state() frameworksLoading: boolean = false;
  @state() frameworks: { key: string; data: PackageFrameworks } | undefined;
  @state() activeTab: DetailTab = "description";

  private readonly _detailsTask = new Task(this, {
    task: async ([packageId, version, source, passwordScriptPath], { signal }) => {
      this.packageDetails = undefined;
      if (!packageId || !version || !source) return;
      this.packageDetailsLoading = true;

      try {
        const request: GetPackageDetailsRequest = {
          Id: packageId,
          Version: version,
          Url: source,
          ...(passwordScriptPath !== undefined && { PasswordScriptPath: passwordScriptPath }),
        };

        const result = await hostApi.getPackageDetailsAsync(request, signal);
        if (signal.aborted) return;

        if (result.ok) this.packageDetails = result.value.Package;
      } finally {
        this.packageDetailsLoading = false;
      }
    },
    args: () => [this.package?.Name, this.selectedVersion, this.source, this.passwordScriptPath] as const,
  });

  /**
   * Supported frameworks need the package's assets, which means downloading it. That is
   * expensive, so the request only fires once the tab is actually open (`tab` is part of
   * the keys below) and only for the precise id/version/source currently on screen.
   */
  private readonly _frameworksTask = new Task(this, {
    task: async ([packageId, version, source, passwordScriptPath, tab], { signal }) => {
      if (tab !== "frameworks") return;
      if (!packageId || !version || !source) return;
      this.frameworksLoading = true;

      try {
        const request: GetPackageFrameworksRequest = {
          Id: packageId,
          Version: version,
          Url: source,
          ...(passwordScriptPath !== undefined && { PasswordScriptPath: passwordScriptPath }),
        };

        const result = await hostApi.getPackageFrameworksAsync(request, signal);
        if (signal.aborted) return;

        if (result.ok) {
          this.frameworks = { key: this.frameworksKey(packageId, version, source), data: result.value };
        } else {
          // Surface the failure through the Task so the tab can offer a retry.
          throw new Error(result.error);
        }
      } finally {
        this.frameworksLoading = false;
      }
    },
    args: () =>
      [
        this.package?.Name,
        this.selectedVersion,
        this.source,
        this.passwordScriptPath,
        this.activeTab,
      ] as const,
  });

  private frameworksKey(packageId: string, version: string, source: string): string {
    return `${packageId}\u0000${version}\u0000${source}`;
  }

  private currentFrameworksKey(): string {
    return this.frameworksKey(this.package?.Name ?? "", this.selectedVersion, this.source);
  }

  private async openUrlAsync(url: string): Promise<void> {
    await hostApi.openUrlAsync({ Url: url });
  }

  private renderDescriptionTab(): unknown {
    if (!this.package) return nothing;

    return html`
      ${this.package.Description
        ? html`<div class="description-text">${this.package.Description}</div>`
        : nothing}

      <div class="package-meta">
        ${this.package.Authors
          ? html`
              <span class="label">Authors</span>
              <span class="value">${this.package.Authors}</span>
            `
          : nothing}

        <span class="label">Total</span>
        <span class="value">${FormatDownloads(this.package.TotalDownloads)}</span>

        <span class="label">Current version</span>
        <span class="value">${FormatDownloads(this.package.DownloadsForVersion(this.selectedVersion))}</span>

        ${this.package.LicenseUrl
          ? html`
              <span class="label">License</span>
              <a href=${this.package.LicenseUrl} @click=${async (e: Event) => { e.preventDefault(); await this.openUrlAsync(this.package!.LicenseUrl); }}>View License</a>
            `
          : nothing}

        ${this.package.ProjectUrl
          ? html`
              <span class="label">Project URL</span>
              <a href=${this.package.ProjectUrl} @click=${async (e: Event) => { e.preventDefault(); await this.openUrlAsync(this.package!.ProjectUrl); }}>View Project</a>
            `
          : nothing}
      </div>

      ${this.package.Tags
        ? html`
            <div class="tags">
              ${this.package.Tags.split(", ")
                .filter((t: string) => t.trim())
                .map((tag: string) => html`<span class="tag">${tag}</span>`)}
            </div>
          `
        : nothing}
    `;
  }

  private renderDependenciesTab(): unknown {
    if (this.packageDetailsLoading) {
      return html`<span class="spinner large loader"></span>`;
    }

    if (this._detailsTask.status === TaskStatus.ERROR) {
      return html`
        <div class="error" role="alert">
          <span class="codicon codicon-error"></span>
          Failed to load package details
        </div>
      `;
    }

    const frameworks = this.packageDetails?.dependencies?.frameworks ?? {};
    const frameworkKeys = Object.keys(frameworks);

    if (frameworkKeys.length > 0) {
      return html`
        <div class="dependencies">
          <ul>
            ${frameworkKeys.map(
              (fw) => html`
                <li>
                  <strong>${fw}</strong>
                  <ul>
                    ${(frameworks[fw] ?? []).map(
                      (dep) => html`<li>${dep.package} ${dep.versionRange}</li>`
                    )}
                  </ul>
                </li>
              `
            )}
          </ul>
        </div>
      `;
    }

    return html`
      <div class="no-dependencies">
        <span class="codicon codicon-info"></span>
        <span>No dependencies</span>
      </div>
    `;
  }

  private renderFrameworksTab(): unknown {
    if (this.frameworksLoading || this._frameworksTask.status === TaskStatus.PENDING) {
      return html`<span class="spinner large loader"></span>`;
    }

    if (this._frameworksTask.status === TaskStatus.ERROR) {
      const reason = this._frameworksTask.error instanceof Error
        ? this._frameworksTask.error.message
        : "";
      return html`
        <div class="error" role="alert">
          <span class="codicon codicon-error"></span>
          Failed to load supported frameworks${reason ? `: ${reason}` : ""} — reopen the tab to retry
        </div>
      `;
    }

    const frameworks = this.frameworks;
    const groups: PackageFrameworkGroup[] = frameworks?.key === this.currentFrameworksKey()
      ? frameworks.data.Groups
      : [];

    if (groups.length === 0) {
      return html`
        <div class="no-dependencies">
          <span class="codicon codicon-info"></span>
          <span>No supported frameworks</span>
        </div>
      `;
    }

    return html`
      <div class="frameworks" role="list" aria-label="Supported frameworks">
        ${groups.map(
          (group) => html`
            <div class="framework-group" role="listitem" aria-label=${group.Product}>
              <div class="framework-product">${group.Product}</div>
              <div class="framework-chips">
                ${group.Frameworks.map(
                  (framework) => html`
                    <span
                      class="tfm-badge ${framework.IsComputed ? "is-computed" : ""}"
                      title=${framework.IsComputed
                        ? `${framework.Name} is supported through compatibility`
                        : `${framework.Name} is declared by the package`}
                    >${framework.Name}</span>
                  `
                )}
              </div>
            </div>
          `
        )}
      </div>
    `;
  }

  private renderVersionsTab(): unknown {
    const versions = this.package?.Versions ?? [];
    const installedVersion = this.package?.InstalledVersion;

    return html`
      <div class="versions-list" role="list" aria-label="Package versions">
        ${versions.map((v) => {
          const isPrerelease = IsPrereleaseVersion(v);
          const isInstalled = v === installedVersion;
          const isCurrent = v === this.selectedVersion;

          return html`
            <div class="version-row ${isCurrent ? "current" : ""}" role="listitem">
              <span class="version-number">${v}</span>
              <span class="version-badges">
                ${isInstalled ? html`<span class="installed-badge">installed</span>` : nothing}
                ${isPrerelease ? html`<span class="prerelease-badge">pre</span>` : nothing}
              </span>
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderActiveTab(): unknown {
    switch (this.activeTab) {
      case "description":
        return this.renderDescriptionTab();
      case "dependencies":
        return this.renderDependenciesTab();
      case "frameworks":
        return this.renderFrameworksTab();
      case "versions":
        return this.renderVersionsTab();
    }
  }

  override render(): unknown {
    return html`
      <div class="detail-tabs" role="tablist">
        <button
          class="detail-tab ${this.activeTab === "description" ? "active" : ""}"
          role="tab"
          aria-selected=${this.activeTab === "description"}
          @click=${() => (this.activeTab = "description")}
        >
          Description
        </button>
        <button
          class="detail-tab ${this.activeTab === "dependencies" ? "active" : ""}"
          role="tab"
          aria-selected=${this.activeTab === "dependencies"}
          @click=${() => (this.activeTab = "dependencies")}
        >
          Dependencies
        </button>
        <button
          class="detail-tab ${this.activeTab === "frameworks" ? "active" : ""}"
          role="tab"
          aria-selected=${this.activeTab === "frameworks"}
          @click=${() => (this.activeTab = "frameworks")}
        >
          Frameworks
        </button>
        <button
          class="detail-tab ${this.activeTab === "versions" ? "active" : ""}"
          role="tab"
          aria-selected=${this.activeTab === "versions"}
          @click=${() => (this.activeTab = "versions")}
        >
          Versions (${this.package?.Versions.length ?? 0})
        </button>
      </div>
      <div class="tab-content" role="tabpanel">
        ${this.renderActiveTab()}
      </div>
    `;
  }
}
