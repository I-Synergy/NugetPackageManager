import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Task, TaskStatus } from "@lit/task";

import codicon from "@/web/styles/codicon.css";
import type { DropdownOption } from "./dropdown";
import "./dropdown";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "@/web/registrations";
import { runConsolidateJobAsync } from "@/web/jobs";
import { buildFrameworkOptions, getBaseTargetFramework, getFrameworkGroupKey, matchesFrameworkSelection } from "@/common/framework";
import { InconsistentPackageViewModel } from "../types";

@customElement("consolidate-view")
export class ConsolidateView extends LitElement {
  static override readonly styles = [
    codicon,
    scrollableBase,
    sharedStyles,
    css`
      :host {
        display: flex;
        flex: 1;
        width: 100%;
      }

      .consolidate-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        overflow: hidden;

        .inconsistent-row {
          padding: 12px;
          margin: 5px 8px;
          border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
          border-radius: var(--npm-radius, 10px);
          background: var(--npm-surface-raised, var(--vscode-editorWidget-background));

          &.consolidating {
            opacity: 0.6;
          }

          .row-header {
            display: flex;
            align-items: center;
            gap: 8px;

            .package-name {
              font-weight: bold;
              font-size: 13px;
              flex: 1;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              cursor: pointer;
            }

            .package-name:hover {
              text-decoration: underline;
            }

            .cpm-badge {
              font-size: 10px;
              padding: 1px 4px;
              border-radius: 3px;
              background-color: var(--vscode-badge-background);
              color: var(--vscode-badge-foreground);
            }

            .row-actions {
              display: flex;
              align-items: center;
              gap: 4px;

              .version-dropdown {
                min-width: 100px;
              }
            }
          }

          .version-details {
            margin-top: 4px;
            padding-left: 4px;

            .version-row {
              display: flex;
              gap: 8px;
              font-size: 11px;
              padding: 2px 0;

              .version {
                min-width: 60px;
                color: var(--vscode-charts-yellow);
                font-family: var(--vscode-editor-font-family);
              }

              .projects {
                color: var(--vscode-descriptionForeground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              }
            }
          }
        }
      }
    `,
  ];

  @state() packages: InconsistentPackageViewModel[] = [];
  @state() isConsolidating: boolean = false;
  @state() statusText: string = "";
  @property() selectedFramework: string = "";
  @property({ attribute: false }) projectPaths: string[] = [];

  private readonly _loadTask = new Task(this, {
    task: async ([projectPaths, forceReload], { signal }) => {
      const req: Parameters<typeof hostApi.getInconsistentPackagesAsync>[0] = {};
      if (projectPaths.length > 0) req.ProjectPaths = projectPaths;
      if (forceReload) req.ForceReload = true;
      const result = await hostApi.getInconsistentPackagesAsync(req, signal);
      if (!result.ok) throw new Error("Failed to check for inconsistencies");
      return (result.value.Packages ?? []).map((p) => new InconsistentPackageViewModel(p));
    },
    args: () => [this.projectPaths, false] as [string[], boolean],
    onComplete: (packages) => {
      this.packages = packages;
      this.statusText = "";
      this.dispatchEvent(new CustomEvent<number>("count-changed", {
        detail: packages.length,
        bubbles: true,
        composed: true,
      }));
      this.dispatchEvent(new CustomEvent("framework-options-changed", {
        detail: this.frameworkOptions,
        bubbles: true,
        composed: true,
      }));
    },
  });

  get frameworkOptions(): Array<{ value: string; label: string }> {
    const values = this.packages.flatMap((p) => p.Versions.map((v) => v.CpmFramework));
    return buildFrameworkOptions(values, values.some((value) => value === ""));
  }

  private packageMatchesFramework(pkg: InconsistentPackageViewModel): boolean {
    return pkg.Versions.some((v) =>
      matchesFrameworkSelection(this.selectedFramework, v.CpmFramework)
    );
  }

  private get visiblePackages(): InconsistentPackageViewModel[] {
    if (this.selectedFramework === "" || this.frameworkOptions.length === 0) return this.packages;
    return this.packages.filter((pkg) => this.packageMatchesFramework(pkg));
  }

  private get groupedVisiblePackages(): Array<{ key: string; label: string; packages: InconsistentPackageViewModel[] }> {
    const groups = new Map<string, InconsistentPackageViewModel[]>();
    for (const pkg of this.visiblePackages) {
      const key = getFrameworkGroupKey(this.selectedFramework, pkg.Versions[0]?.CpmFramework ?? "");
      const list = groups.get(key) ?? [];
      list.push(pkg);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([key, packages]) => ({
        key,
        label: key || "Shared",
        packages,
      }))
      .sort((a, b) => {
        if (a.key === "" && b.key !== "") return -1;
        if (a.key !== "" && b.key === "") return 1;
        return a.key.localeCompare(b.key);
      });
  }

  async LoadInconsistentPackagesAsync(forceReload: boolean = false): Promise<void> {
    this.packages = [];
    this.statusText = "";
    try {
      await this._loadTask.run([this.projectPaths, forceReload]);
    } catch (err) {
      // Avoid unhandled promise rejections; rely on TaskStatus.ERROR for rendering.
      console.error(err);
    }
  }

  private selectPackage(packageId: string): void {
    this.dispatchEvent(new CustomEvent("package-selected", {
      detail: { packageId },
      bubbles: true,
      composed: true,
    }));
  }

  private readonly _jobIds = new Map<string, string>();

  private jobKey(pkg: InconsistentPackageViewModel): string {
    return `${pkg.Id}|${pkg.Versions[0]?.CpmCondition ?? ""}|${pkg.Versions[0]?.CpmFramework ?? ""}`;
  }

  private async cancelConsolidateAsync(pkg: InconsistentPackageViewModel): Promise<void> {
    const jobId = this._jobIds.get(this.jobKey(pkg));
    if (!jobId) return;
    const result = await hostApi.cancelJobAsync({ JobId: jobId });
    if (!result.ok) {
      this.statusText = `Failed to cancel ${pkg.Id}: ${result.error}`;
      this.requestUpdate();
    }
  }

  private async consolidateSingleAsync(pkg: InconsistentPackageViewModel): Promise<boolean> {
    pkg.IsConsolidating = true;
    this.requestUpdate();
    try {
      const target = pkg.Versions.find((v) => v.Version === pkg.TargetVersion) ?? pkg.Versions[0];
      const condition = target?.CpmCondition ?? "";
      const framework = target?.CpmFramework ?? "";

      // Consolidate only the projects that belong to the selected framework line.
      // A multi-target project appears in both lines, but this request must address
      // exactly one CPM condition. Never send the other line's projects here.
      const lineVersions = pkg.Versions.filter(
        (v) => (v.CpmCondition ?? "") === condition && (v.CpmFramework ?? "") === framework
      );
      const allProjects = [...new Set(
        (lineVersions.length > 0 ? lineVersions : pkg.Versions)
          .flatMap((v) => v.Projects.map((p) => p.Path))
      )];
      const key = this.jobKey(pkg);
      const result = await runConsolidateJobAsync({
        PackageId: pkg.Id,
        TargetVersion: pkg.TargetVersion,
        ProjectPaths: allProjects,
        ...(condition
          ? { CpmCondition: condition, Scope: "group" as const }
          : { Scope: "unconditional" as const }),
      }, {
        onStarted: (jobId) => {
          this._jobIds.set(key, jobId);
          this.requestUpdate();
        },
      });

      if (!result.ok) {
        this.statusText = /cancelled/i.test(result.error)
          ? `Consolidation of ${pkg.Id} was cancelled`
          : `Failed to consolidate ${pkg.Id}: ${result.error}`;
        return false;
      }

      // Remove only the framework line that was consolidated; another TFM row
      // for the same package must remain visible.
      this.packages = this.packages.filter(
        (p) =>
          !(
            p.Id === pkg.Id
            && (p.Versions[0]?.CpmCondition ?? "") === condition
            && (p.Versions[0]?.CpmFramework ?? "") === framework
          )
      );
      this.dispatchEvent(new CustomEvent<number>("count-changed", {
        detail: this.packages.length,
        bubbles: true,
        composed: true,
      }));
      const packageWord = this.packages.length === 1 ? "package" : "packages";
      this.statusText =
        this.packages.length > 0
          ? `${this.packages.length} ${packageWord} with inconsistent versions`
          : "All versions are consistent";
      return true;
    } catch (err) {
      this.statusText = `Failed to consolidate ${pkg.Id}: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    } finally {
      this._jobIds.delete(this.jobKey(pkg));
      pkg.IsConsolidating = false;
      this.requestUpdate();
    }
  }

  private async consolidateAllAsync(): Promise<void> {
    const visible = this.visiblePackages;
    if (visible.length === 0) return;

    const confirm = await hostApi.showConfirmationAsync({
      Message: `Consolidate ${visible.length} package${visible.length !== 1 ? "s" : ""}?`,
      Detail: "Each framework line is consolidated to its own target version. Lines are never merged.",
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.isConsolidating = true;
    try {
      const results: boolean[] = [];
      // Sequential: multiple framework lines can share one Directory.Packages.props,
      // so writes must observe the previous line's update.
      for (const pkg of visible) {
        results.push(await this.consolidateSingleAsync(pkg));
      }
      const failed = results.filter((success) => !success);
      if (failed.length > 0) {
        this.statusText = `${failed.length} package${failed.length !== 1 ? "s" : ""} failed to consolidate`;
      }
    } finally {
      this.isConsolidating = false;
      await this.LoadInconsistentPackagesAsync();
    }
  }

  private renderPackageRow(pkg: InconsistentPackageViewModel): unknown {
    return html`
      <div class="inconsistent-row ${pkg.IsConsolidating ? "consolidating" : ""}">
        <div class="row-header">
          <span class="package-name" @click=${() => this.selectPackage(pkg.Id)}>${pkg.Id}</span>
          ${pkg.CpmManaged ? html`<span class="cpm-badge">CPM</span>` : nothing}
          ${pkg.Versions[0]?.CpmFramework
            ? html`<span class="tfm-badge">${getBaseTargetFramework(pkg.Versions[0].CpmFramework)}</span>`
            : nothing}
          <div class="row-actions">
            ${pkg.IsConsolidating
              ? html`
                  <span class="spinner medium"></span>
                  <button
                    class="icon-btn"
                    aria-label="Cancel consolidation of ${pkg.Id}"
                    title="Cancel"
                    ?disabled=${!this._jobIds.has(this.jobKey(pkg))}
                    @click=${async () => await this.cancelConsolidateAsync(pkg)}
                  >
                    <span class="codicon codicon-close"></span>
                  </button>
                `
              : html`
                  <custom-dropdown
                    class="version-dropdown"
                    ariaLabel="Target version for ${pkg.Id}"
                    .options=${pkg.Versions.map((v): DropdownOption => ({ value: v.Version, label: v.Version }))}
                    .value=${pkg.TargetVersion}
                    @change=${(e: CustomEvent<string>) => {
                      pkg.TargetVersion = e.detail;
                      this.requestUpdate();
                    }}
                  ></custom-dropdown>
                  <button class="icon-btn" aria-label="Consolidate ${pkg.Id}" title="Consolidate ${pkg.Id}" @click=${async () => await this.consolidateSingleAsync(pkg)}>
                    <span class="codicon codicon-arrow-circle-up"></span>
                  </button>
                `}
          </div>
        </div>
        <div class="version-details">
          ${pkg.Versions.map(
            (v) => html`
              <div class="version-row">
                <span class="version">${v.Version}</span>
                ${v.CpmFramework && !this.selectedFramework
                  ? html`<span class="tfm-badge">${getBaseTargetFramework(v.CpmFramework)}</span>`
                  : nothing}
                <span class="projects">${v.Projects.map((p) => p.Name).join(", ")}</span>
              </div>
            `
          )}
        </div>
      </div>
    `;
  }

  override render(): unknown {
    const isLoading = this._loadTask.status === TaskStatus.PENDING;
    const hasError = this._loadTask.status === TaskStatus.ERROR;
    const visible = this.visiblePackages;

    return html`
      <div class="consolidate-container" aria-busy=${isLoading}>
        <div class="list-header">
          <div>
            <div class="list-title">Consolidate versions</div>
            <div class="list-subtitle">
              ${visible.length} package${visible.length !== 1 ? "s" : ""} with inconsistent versions
              ${this.statusText ? html` · ${this.statusText}` : nothing}
            </div>
          </div>
          <div class="list-actions">
            ${this.packages.length > 0
              ? html`
                  <button
                    class="primary-btn"
                    ?disabled=${this.isConsolidating}
                    @click=${async () => await this.consolidateAllAsync()}
                  >
                    Consolidate all
                  </button>
                `
              : nothing}
          </div>
        </div>

        ${isLoading
          ? html`
              <div class="loading" role="status" aria-label="Loading">
                <span class="spinner large"></span>
                <span>Checking for inconsistencies...</span>
              </div>
            `
          : nothing}
        ${!isLoading && visible.length === 0 && !hasError
          ? html`
              <div class="empty">
                <span class="codicon codicon-check"></span>
                <div class="empty-title">All package versions are consistent</div>
                <div class="empty-hint">There is nothing to consolidate in the selected projects.</div>
              </div>
            `
          : nothing}
        ${hasError
          ? html`
              <div class="error" role="alert">
                <span class="codicon codicon-error"></span>
                Failed to check for inconsistencies
              </div>
            `
          : nothing}
        ${!isLoading && visible.length > 0
          ? html`
              <div class="package-list" role="list" aria-label="Inconsistent packages">
                ${this.groupedVisiblePackages.map(
                  (group) => html`
                    <div class="group-header">
                      ${group.label}
                      <span class="group-count">${group.packages.length}</span>
                    </div>
                    ${group.packages.map((pkg) => this.renderPackageRow(pkg))}
                  `
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
