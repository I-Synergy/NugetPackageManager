import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import Split from "split.js";
import debounce from "lodash/debounce";
import { hostApi, configuration } from "@/web/registrations";
import { runBatchUpdateJobAsync, runOutdatedScanJobAsync, runProjectUpdateJobAsync, runWorkspaceScanJobAsync } from "@/web/jobs";
import { buildFrameworkOptions, getFrameworkGroupKey, matchesFrameworkSelection, shouldShowFrameworkGroups } from "@/common/framework";
import { IsPrereleaseVersion } from "@/common/package-display";
import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { PackageViewModel, ProjectViewModel } from "../types";
import type { BatchUpdateRequest } from "@/common/rpc/types";
import type { FilterEvent, SearchBar } from "./search-bar";
import type { UpdatesView } from "./updates-view";
import type { ConsolidateView } from "./consolidate-view";
import type { VulnerabilitiesView } from "./vulnerabilities-view";
import type { CleanupView } from "./cleanup-view";
import type { ToolchainView } from "./toolchain-view";
import type { DropdownOption } from "./dropdown";
import "./dropdown";
import "./toolchain-banner";
import "./toolchain-view";

type TabId = "browse" | "installed" | "updates" | "consolidate" | "cleanup" | "vulnerabilities" | "toolchain";

const PACKAGE_FETCH_TAKE = 50;
const PACKAGE_CONTAINER_SCROLL_MARGIN = 196;
const NUGET_ORG_PREFIX = "https://api.nuget.org";
/** Shown until the workspace scan job reports its first stage. */
const PROJECTS_LOADING_MESSAGE = "Discovering projects and resolving target frameworks…";

@customElement("packages-view")
export class PackagesView extends LitElement {
  static override readonly styles = [
    codicon,
    scrollableBase,
    sharedStyles,
    css`
      .container {
        display: flex;
        height: 100%;
        padding: 8px;
        gap: 8px;

        .error {
          display: flex;
          gap: 4px;
          justify-content: center;
          flex: 1;
          margin-top: 32px;
          color: var(--vscode-errorForeground);
        }

        &:focus-visible {
          outline: unset;
        }

        .col {
          overflow: hidden;
          border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
          border-radius: var(--npm-radius, 10px);
          background: var(--npm-surface, var(--vscode-sideBar-background));
        }

        .gutter {
          display: flex;
          margin: 0 2px;
          justify-content: center;
          transition: background-color 0.1s ease-out;

          &:hover {
            cursor: col-resize;
            background-color: var(--vscode-sash-hoverBorder);
          }
        }

        .gutter-nested {
          width: 1px;
          background-color: var(--vscode-panelSection-border);
        }

        #project-tree {
          display: flex;
          flex-direction: column;
        }

        #packages {
          display: flex;
          flex-direction: column;

          .loader {
            align-self: center;
            margin: 10px 0;
          }

          .tab-bar {
            display: flex;
            align-items: center;
            gap: 1px;
            padding: 8px 6px 6px;
            margin-bottom: 0;
            border-bottom: 1px solid var(--npm-border, var(--vscode-panelSection-border));
            overflow-x: auto;
            scrollbar-width: none;
          }

          .scope-summary {
            font-size: 9px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            margin: 0 8px 4px 2px;
          }

          .tab-tree-toggle {
            margin-right: 2px;

            &.active {
              color: var(--vscode-panelTitle-activeForeground);
            }
          }

          .tab {
            background: transparent;
            border: 1px solid transparent;
            color: var(--vscode-descriptionForeground);
            padding: 5px 8px;
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            border-radius: 8px;
            opacity: 0.9;
            flex-shrink: 0;
          }

          .tab-cleanup {
            order: 99;
          }

          .tab:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
          }

          .tab.active {
            opacity: 1;
            background: var(--npm-accent, var(--vscode-button-background));
            color: var(--npm-accent-fg, var(--vscode-button-foreground));
            box-shadow: 0 3px 10px color-mix(in srgb, var(--npm-accent, #6c5ce7) 30%, transparent);
          }

          .tab-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 14px;
            height: 14px;
            padding: 0 3px;
            margin-left: 3px;
            font-size: 9px;
            font-weight: bold;
            border-radius: 8px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            line-height: 1;
          }

          .vulnerability-banner {
            display: flex;
            align-items: center;
            gap: 7px;
            margin: 8px 8px 0;
            padding: 8px 11px;
            border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
            border-radius: 8px;
            background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.12));
            color: var(--vscode-foreground);
            font-size: 11px;
            text-align: left;
            cursor: pointer;
          }

          .vulnerability-banner:hover {
            background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.2));
          }

          .tab-content {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            margin-top: 4px;
          }

          .tab-content.hidden {
            display: none;
          }

          .installed-packages {
            flex-direction: column;
          }

          .installed-update-status {
            margin: 4px 8px 0;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
          }

          .installed-update-error {
            color: var(--vscode-errorForeground);
          }

          .packages-container {
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            flex: 1;

            .package {
              margin-bottom: 3px;
            }

          }
        }

        #projects {
          display: flex;
          flex-direction: column;
          min-height: 0;

          .packages-details-loader {
            align-self: center;
            margin-top: 20px;
          }

          .details-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 8px;
            height: 100%;
            padding: 24px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
          }

          .details-empty .big-icon {
            font-size: 28px;
            opacity: 0.45;
          }

          .details-empty .title {
            color: var(--vscode-foreground);
            font-size: 13px;
            font-weight: 600;
          }

          .details-empty .hint {
            font-size: 11px;
            max-width: 220px;
            line-height: 1.5;
          }

          .package-header-panel {
            display: flex;
            align-items: flex-start;
            gap: 13px;
            padding: 16px;
            border-bottom: 1px solid var(--npm-border, var(--vscode-panelSection-border));
            background: linear-gradient(135deg, color-mix(in srgb, var(--npm-accent, #6c5ce7) 12%, transparent), transparent);

            .package-icon-large {
              width: 46px;
              height: 46px;
              border-radius: 12px;
              flex-shrink: 0;
            }

            .package-header-info {
              flex: 1;
              min-width: 0;
              display: flex;
              flex-direction: column;
              gap: 2px;

              .package-title-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;

                .package-title {
                  font-size: 16px;
                  font-weight: 700;
                  overflow: hidden;
                  text-overflow: ellipsis;
                  white-space: nowrap;

                  a {
                    text-decoration: none;
                    color: var(--vscode-editor-foreground);
                  }

                  .package-link-icon {
                    vertical-align: middle;
                    font-size: 12px;
                    margin-right: 3px;
                  }
                }

                .source-badge {
                  display: flex;
                  align-items: center;
                  gap: 4px;
                  font-size: 11px;
                  color: var(--vscode-descriptionForeground);
                  white-space: nowrap;
                  flex-shrink: 0;

                  .codicon {
                    font-size: 12px;
                  }
                }

                .details-verified {
                  color: var(--vscode-charts-blue, #3794ff);
                  font-size: 10px;
                  white-space: nowrap;
                }
              }

              .package-authors-row {
                font-size: 11px;
                color: var(--vscode-descriptionForeground);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              }
            }
          }

          .package-actions-row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 10px 16px;

            .remove-all-btn {
              margin-left: auto;
            }

            .version-selector {
              display: flex;
              align-items: center;
              gap: 6px;
              white-space: nowrap;
              min-width: 128px;

              .detail-label {
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 0.4px;
                text-transform: uppercase;
                color: var(--vscode-descriptionForeground);
              }
            }
          }

          .package-action-error {
            margin: 0 16px 8px;
            padding: 7px 9px;
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 3px;
            color: var(--vscode-errorForeground);
            font-size: 11px;
            white-space: pre-wrap;
          }

          .projects-panel-container {
            overflow-y: auto;
            overflow-x: hidden;
            flex: 1;
            min-height: 0;
            padding: 4px 0 10px;

            .no-projects {
              display: flex;
              gap: 4px;
              margin-left: 6px;
            }

            .separator {
              margin: 10px 0px;
              height: 1px;
              background-color: var(--vscode-panelSection-border);
            }
          }
        }
      }
    `,
  ];

  private splitter: Split.Instance | null = null;
  private _packagesAc: AbortController | null = null;
  private _projectsAc: AbortController | null = null;
  private _projectsPackagesAc: AbortController | null = null;
  packagesPage: number = 0;
  packagesLoadingInProgress: boolean = false;

  @state() activeTab: TabId = "browse";
  @state() projects: Array<ProjectViewModel> = [];
  @state() private _allProjectPaths: string[] = [];
  @state() selectedVersion: string = "";
  @state() selectedPackage: PackageViewModel | null = null;
  @state() packages: Array<PackageViewModel> = [];
  @state() projectsPackages: Array<PackageViewModel> = [];
  @state() updatesCount: number | null = null;
  @state() private updatesCountLoading: boolean = false;
  @state() consolidateCount: number | null = null;
  @state() cleanupCount: number | null = null;
  @state() vulnerabilitiesCount: number | null = null;
  @state() toolchainCount: number | null = null;
  @state() filters: FilterEvent = {
    Prerelease: true,
    Query: "",
    SourceUrl: "",
    Sort: "relevance",
  };
  @state() noMorePackages: boolean = false;
  @state() packagesLoadingError: boolean = false;
  @state() packagesLoadingErrorMessage: string = "";
  @state() selectedProjectPaths: string[] = [];
  @state() showProjectTree: boolean = false;
  @state() private _installedFramework = "";
  @state() private _updatesFrameworkOptions: Array<{ value: string; label: string }> = [];
  @state() private _updatesFramework = "";
  @state() private _consolidateFrameworkOptions: Array<{ value: string; label: string }> = [];
  @state() private _consolidateFramework = "";
  @state() private removingPackage = false;
  @state() private updatingInstalledKeys = new Set<string>();
  @state() private installedUpdateStatus = "";
  @state() private installedUpdateError = "";
  private _removeJobId = "";
  private _removeCancelled = false;
  @state() private removeError = "";
  @state() private projectsLoading = false;
  @state() private projectsLoadingMessage = PROJECTS_LOADING_MESSAGE;
  private _refreshAc: AbortController | undefined;
  private _connected = false;

  override connectedCallback(): void {
    this._connected = true;
    this._refreshAc = new AbortController();
    super.connectedCallback();
    this.filters = {
      ...this.filters,
      SourceUrl: "",
      Prerelease: configuration.Configuration?.Prerelease ?? false,
    };
    // LoadPackages is triggered by search-bar's connectedCallback emitting filter-changed
    // connectedCallback cannot be async (Web Components spec) — void is intentional
    void this.LoadProjectsAsync();
  }


  override firstUpdated(): void {
    this.initSplitter();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._connected = false;
    this._refreshAc?.abort();
    this._refreshAc = undefined;
    this.debouncedLoadProjectsPackages.cancel();
    this.splitter?.destroy();
    this._packagesAc?.abort();
    this._projectsAc?.abort();
    this._projectsPackagesAc?.abort();
  }

  private initSplitter(): void {
    this.splitter?.destroy();
    this.splitter = null;
    const packages = this.shadowRoot!.getElementById("packages")!;
    const projects = this.shadowRoot!.getElementById("projects")!;
    if (this.showProjectTree) {
      const projectTree = this.shadowRoot!.getElementById("project-tree")!;
      this.splitter = Split([projectTree, packages, projects], {
        sizes: [20, 45, 35],
        minSize: [120, 200, 150],
        gutterSize: 4,
        gutter: this.makeGutter,
      });
    } else {
      this.splitter = Split([packages, projects], {
        sizes: [55, 45],
        minSize: [200, 150],
        gutterSize: 4,
        gutter: this.makeGutter,
      });
    }
  }

  private makeGutter(_index: number, direction: string): HTMLElement {
    const gutter = document.createElement("div");
    const gutterNested = document.createElement("div");
    gutter.className = `gutter gutter-${direction}`;
    gutterNested.className = "gutter-nested";
    gutter.appendChild(gutterNested);
    return gutter;
  }

  private async toggleProjectTreeAsync(): Promise<void> {
    this.showProjectTree = !this.showProjectTree;
    await this.updateComplete;
    this.initSplitter();
    await this.reloadChildViewsAsync();
  }

  get CurrentSource() {
    return configuration.Configuration?.Sources.find((s) => s.Url === this.filters.SourceUrl);
  }

  get NugetOrgPackageUrl(): string | null {
    const sourceUrl = this.selectedPackage?.SourceUrl || this.filters.SourceUrl;
    if (sourceUrl.startsWith(NUGET_ORG_PREFIX)) {
      return `https://www.nuget.org/packages/${this.selectedPackage?.Name}/${this.selectedVersion}`;
    }
    return null;
  }

  private get effectiveProjectPaths(): string[] {
    if (this.showProjectTree) return this.selectedProjectPaths;
    // When the project tree is hidden, still scope to the solution-filtered project list
    // so that updates/consolidate/vulnerabilities don't scan non-solution projects.
    return this._allProjectPaths;
  }

  private get filteredProjects(): Array<ProjectViewModel> {
    if (!this.showProjectTree || this.selectedProjectPaths.length === 0) return this.projects;
    return this.projects.filter((p) => this.selectedProjectPaths.includes(p.Path));
  }

  private async handleTabKeydownAsync(e: KeyboardEvent): Promise<void> {
    const tabs: TabId[] = ["browse", "installed", "updates", "consolidate", "vulnerabilities", "cleanup", "toolchain"];
    const currentIdx = tabs.indexOf(this.activeTab);
    let newIdx: number;

    switch (e.key) {
      case "ArrowRight":
        newIdx = (currentIdx + 1) % tabs.length;
        break;
      case "ArrowLeft":
        newIdx = (currentIdx - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        newIdx = 0;
        break;
      case "End":
        newIdx = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    await this.setTabAsync(tabs[newIdx] as TabId);
    const tabButtons = this.shadowRoot?.querySelectorAll('[role="tab"]');
    (tabButtons?.[newIdx] as HTMLElement | undefined)?.focus();
  }

  async setTabAsync(tab: TabId): Promise<void> {
    if (tab === this.activeTab) return;
    this.activeTab = tab;
    await this.updateComplete;
    // Visiting a data tab must show the current workspace, not the cached scan
    // from an earlier visit. Force the reload for the analysis tabs; Cleanup and
    // Toolchain expose refresh methods that cover their nested sections too.
    if (tab === "updates") {
      await (this.shadowRoot?.querySelector("updates-view") as UpdatesView | null)?.LoadOutdatedPackagesAsync(true);
    } else if (tab === "consolidate") {
      await (this.shadowRoot?.querySelector("consolidate-view") as ConsolidateView | null)?.LoadInconsistentPackagesAsync(true);
    } else if (tab === "cleanup") {
      await (this.shadowRoot?.querySelector("cleanup-view") as CleanupView | null)?.RefreshAsync();
    } else if (tab === "vulnerabilities") {
      await (this.shadowRoot?.querySelector("vulnerabilities-view") as VulnerabilitiesView | null)?.LoadVulnerablePackagesAsync(true);
    } else if (tab === "toolchain") {
      await (this.shadowRoot?.querySelector("toolchain-view") as ToolchainView | null)?.RefreshAsync();
    }
  }

  private async onPackagesUpdatedAsync(): Promise<void> {
    if (!this._connected) return;
    await this.LoadProjectsAsync(true);
    await this.reloadChildViewsAsync(true);
  }

  private async onChildPackageSelectedAsync(e: CustomEvent<{ packageId: string; sourceUrl?: string }>): Promise<void> {
    const { packageId, sourceUrl } = e.detail;

    const existing = this.projectsPackages.find((p) => p.Id === packageId);
    if (existing) {
      // A child row (Updates) reports the feed it read. The installed copy may have been
      // enriched by whichever configured feed answered first — often one without
      // popularity data — so refresh from the row's own source before showing it.
      if (sourceUrl && (existing.SourceUrl !== sourceUrl || existing.TotalDownloads == null)) {
        await this.RefreshInstalledPackageFromSourceAsync(existing, sourceUrl);
      }
      await this.SelectPackageAsync(existing);
      return;
    }

    const browsePkg = this.packages.find((p) => p.Id === packageId);
    if (browsePkg) {
      await this.SelectPackageAsync(browsePkg);
      return;
    }

    const pkg = PackageViewModel.Empty(packageId);
    if (sourceUrl) pkg.SourceUrl = sourceUrl;
    await this.SelectPackageAsync(pkg);
  }

  /**
   * Re-read metadata for an installed package from the source a child row came from.
   * `InstalledVersion` is what the projects panel keys off, so it survives the refresh.
   * A failed fetch leaves the package exactly as it was: showing stale metadata is better
   * than an empty Details panel for a package the project definitely uses.
   */
  private async RefreshInstalledPackageFromSourceAsync(
    installed: PackageViewModel,
    sourceUrl: string
  ): Promise<void> {
    const request: Parameters<typeof hostApi.getPackageAsync>[0] = {
      Id: installed.Id,
      Url: sourceUrl,
      Prerelease: this.filters.Prerelease,
    };
    const source = configuration.Configuration?.Sources.find((s) => s.Url === sourceUrl);
    if (source?.Name !== undefined) request.SourceName = source.Name;
    if (source?.PasswordScriptPath !== undefined) request.PasswordScriptPath = source.PasswordScriptPath;

    const result = await hostApi.getPackageAsync(request);
    if (!result.ok || !result.value.Package) return;

    const installedVersion = installed.InstalledVersion;
    installed.UpdatePackage(result.value.Package, result.value.SourceUrl || sourceUrl);
    installed.InstalledVersion = installedVersion;
    installed.Status = "Detailed";
  }

  async setSearchQueryAsync(query: string): Promise<void> {
    await this.setTabAsync("browse");
    await this.updateComplete;
    const searchBar = this.shadowRoot?.querySelector("search-bar") as SearchBar | null;
    searchBar?.setSearchQuery(query);
  }

  private async OnProjectSelectionChangedAsync(paths: string[]): Promise<void> {
    this.selectedProjectPaths = paths;
    await this.reloadChildViewsAsync();
    await this.RefreshVulnerabilityCountAsync();
    await this.RefreshUpdateCountAsync();
    void this.debouncedLoadProjectsPackages();
  }

  private async reloadChildViewsAsync(forceReload: boolean = false): Promise<void> {
    const updates = this.shadowRoot?.querySelector("updates-view") as UpdatesView | null;
    const consolidate = this.shadowRoot?.querySelector("consolidate-view") as ConsolidateView | null;
    const vulnerabilities = this.shadowRoot?.querySelector("vulnerabilities-view") as VulnerabilitiesView | null;
    await Promise.all([
      updates?.LoadOutdatedPackagesAsync(forceReload),
      consolidate?.LoadInconsistentPackagesAsync(forceReload),
      vulnerabilities?.LoadVulnerablePackagesAsync(forceReload),
    ]);
  }

  private readonly debouncedLoadProjectsPackages = debounce(async () => {
    await this.LoadProjectsPackagesAsync();
    await this.RefreshVulnerabilityCountAsync();
  }, 300);

  private async RefreshUpdateCountAsync(): Promise<void> {
    if (!this._connected) {
      this.updatesCountLoading = false;
      return;
    }
    const paths = this.effectiveProjectPaths;
    if (paths.length === 0) {
      this.updatesCount = 0;
      this.updatesCountLoading = false;
      await hostApi.updateBadgeAsync({ Count: 0, BlockedCount: 0 });
      return;
    }
    const signal = this._refreshAc?.signal;
    // The count comes from the same scan the Updates tab runs, so it goes through the job as well:
    // on a large repository the scan outlives the RPC deadline, and a timed-out badge request used
    // to be indistinguishable from a real failure. This view only needs the number, so an abort or
    // a cancelled job just clears the spinner.
    const result = await runOutdatedScanJobAsync(
      { ProjectPaths: paths, Prerelease: this.filters.Prerelease },
      signal ? { signal } : {}
    );
    if (!this._connected || signal?.aborted) {
      this.updatesCountLoading = false;
      return;
    }
    if (result.ok) {
      this.updatesCount = result.value.Packages.length;
      this.updatesCountLoading = false;
      await hostApi.updateBadgeAsync({
        Count: this.updatesCount,
        BlockedCount: result.value.BlockedPackages?.length ?? 0,
      });
    } else {
      this.updatesCountLoading = false;
    }
  }

  private async RefreshVulnerabilityCountAsync(): Promise<void> {
    if (!this._connected) return;
    const paths = this.effectiveProjectPaths;
    if (paths.length === 0) {
      this.vulnerabilitiesCount = null;
      return;
    }
    const signal = this._refreshAc?.signal;
    const result = await hostApi.getVulnerablePackagesAsync({ ProjectPaths: paths }, signal);
    if (!this._connected || signal?.aborted) return;
    if (result.ok) {
      this.vulnerabilitiesCount = result.value.Packages.length;
    }
  }

  async LoadProjectsPackagesAsync(forceReload: boolean = false, _signal?: AbortSignal): Promise<void> {
    this._projectsPackagesAc?.abort();
    this._installedFramework = "";
    const ac = new AbortController();
    this._projectsPackagesAc = ac;
    const projectsToUse =
      this.selectedProjectPaths.length > 0
        ? this.projects.filter((p) =>
            this.selectedProjectPaths.includes(p.Path)
          )
        : this.projects;

    const packages = projectsToUse
      ?.flatMap((p) =>
        p.Packages.flatMap((pkg) => {
          if (!pkg.CpmResolutions || pkg.CpmResolutions.length === 0) {
            return [pkg];
          }

          const conditional = pkg.CpmResolutions.filter((r) => r.Tfm !== "");
          const unconditional = pkg.CpmResolutions.find((r) => r.Tfm === "");

          if (conditional.length === 0) {
            return [unconditional ? { ...pkg, Version: unconditional.Version } : pkg];
          }

          const entries = conditional.map((r) => ({
            ...pkg,
            Version: r.Version,
            CpmFramework: r.Tfm,
          }));
          if (unconditional) {
            entries.push({ ...pkg, Version: unconditional.Version, CpmFramework: "" });
          }
          return entries;
        })
      )
      .filter((x) =>
        x.Id.toLowerCase().includes(this.filters.Query?.toLowerCase())
      );

    const grouped = packages.reduce(
      (
        acc: {
          [key: string]: { id: string; framework: string; versions: string[]; allowsUpdate: boolean };
        },
        item
      ) => {
        const { Id, Version, IsPinned, CpmFramework } = item;
        const framework = CpmFramework ?? "";
        // Separate by framework so net8.0 and net9.0 versions of the same package
        // show as distinct rows rather than collapsing into "Multiple"
        const key = framework ? `${Id}\0${framework}` : Id;

        if (!acc[key]) {
          acc[key] = { id: Id, framework, versions: [], allowsUpdate: false };
        }

        if (acc[key].versions.indexOf(Version) < 0) {
          acc[key].versions.push(Version);
        }

        if (!IsPinned) {
          acc[key].allowsUpdate = true;
        }

        return acc;
      },
      {}
    );

    this.projectsPackages = Object.entries(grouped).map(([_key, data]) => {
      const pkg = PackageViewModel.Empty(data.id);
      pkg.Versions = [...data.versions];
      pkg.InstalledVersion = data.versions.length > 1 ? "Multiple" : (data.versions[0] ?? "");
      pkg.AllowsUpdate = data.allowsUpdate;
      pkg.CpmFramework = data.framework;
      return pkg;
    });

    const total = this.projectsPackages.length;
    let completed = 0;

    if (total > 0) {
      void hostApi.updateStatusBarAsync({
        Percentage: 0,
        Message: "Loading installed packages...",
      });
    }

    try {
      const CONCURRENCY = 5;
      let idx = 0;
      const runNextAsync = async (): Promise<void> => {
        while (idx < this.projectsPackages.length) {
          if (ac.signal.aborted) return;
          const pkg = this.projectsPackages[idx++]!;
          await this.UpdatePackageAsync(pkg, forceReload, ac.signal);
          if (ac.signal.aborted) return;
          completed++;
          void hostApi.updateStatusBarAsync({
            Percentage: (completed / total) * 100,
            Message: "Loading installed packages...",
          });
        }
      };
      const workers = Array.from({ length: Math.min(CONCURRENCY, this.projectsPackages.length) }, runNextAsync);
      await Promise.allSettled(workers);
    } finally {
      if (!ac.signal.aborted) {
        this.projectsPackages = [...this.projectsPackages];
        if (total > 0) {
          void hostApi.updateStatusBarAsync({ Percentage: null });
        }
      }
    }
  }

  async OnProjectUpdatedAsync(event: CustomEvent): Promise<void> {
    const isCpmEnabled = event.detail?.isCpmEnabled ?? false;
    if (isCpmEnabled) {
      await this.LoadProjectsAsync();
    } else {
      await this.LoadProjectsPackagesAsync();
    }
  }

  private async UpdatePackageAsync(
    projectPackage: PackageViewModel,
    forceReload: boolean = false,
    signal?: AbortSignal
  ): Promise<void> {
    const updatePkgReq: Parameters<typeof hostApi.getPackageAsync>[0] = {
      Id: projectPackage.Id,
      Url: this.filters.SourceUrl,
      Prerelease: this.filters.Prerelease,
      ForceReload: forceReload,
    };
    if (this.CurrentSource?.Name !== undefined) updatePkgReq.SourceName = this.CurrentSource.Name;
    if (this.CurrentSource?.PasswordScriptPath !== undefined) updatePkgReq.PasswordScriptPath = this.CurrentSource.PasswordScriptPath;
    const result = await hostApi.getPackageAsync(updatePkgReq, signal);

    if (signal?.aborted) return;
    if (!result.ok || !result.value.Package) {
      projectPackage.Status = "Error";
    } else {
      if (projectPackage.Version !== "") result.value.Package.Version = "";
      projectPackage.UpdatePackage(
        result.value.Package,
        result.value.SourceUrl
      );
      projectPackage.Status = "Detailed";
    }
  }

  async UpdatePackagesFiltersAsync(filters: FilterEvent): Promise<void> {
    const sourceChanged = this.filters.SourceUrl !== filters.SourceUrl;
    const prereleaseChanged = this.filters.Prerelease !== filters.Prerelease;
    if (prereleaseChanged) {
      // The current count belongs to the other prerelease filter. Drop it right
      // away so the tab badge never shows a stale number for this filter.
      this.updatesCountLoading = true;
      this.updatesCount = null;
    }
    this.filters = filters;
    // Only clear the NuGet API factory cache when the source changes.
    // Prerelease changes don't need it: the package cache key is "${id}::${prerelease}",
    // so a new prerelease state already results in a natural cache miss.
    // Clearing the factory on every prerelease toggle destroyed all NuGetApi instances,
    // forcing expensive re-creation (config file reads, source index HTTP calls) for every
    // installed package — causing ~15 s delays.
    await this.LoadPackagesAsync(false, sourceChanged);
    await this.LoadProjectsPackagesAsync(sourceChanged);

    // Only explicitly reload child views when the source changes (force-reload to bypass cache).
    // Prerelease changes are handled automatically: the child Task args include `prerelease`
    // as a bound property, so a prerelease toggle already triggers an auto-rerun.
    if (sourceChanged) {
      await this.reloadChildViewsAsync(true);
    }
    if (prereleaseChanged) {
      const updates = this.shadowRoot?.querySelector("updates-view") as UpdatesView | null;
      // A mounted Updates tab reruns its Task from the changed `prerelease` property
      // (or from the source reload above) and reports the new count through
      // `badge-changed`. With no Updates tab mounted nothing scans, so do it here.
      if (!updates) await this.RefreshUpdateCountAsync();
    }
  }

  private async OnUpdatesBadgeChangedAsync(
    event: CustomEvent<{ Count: number; BlockedCount: number }>
  ): Promise<void> {
    this.updatesCount = event.detail.Count;
    this.updatesCountLoading = false;
    if (!this._connected) return;
    await hostApi.updateBadgeAsync({
      Count: event.detail.Count,
      BlockedCount: event.detail.BlockedCount,
    });
  }

  async SelectPackageAsync(
    selectedPackage: PackageViewModel
  ): Promise<void> {
    this.packages
      .filter((x) => x.Selected)
      .forEach((x) => (x.Selected = false));
    this.projectsPackages
      .filter((x) => x.Selected)
      .forEach((x) => (x.Selected = false));
    selectedPackage.Selected = true;
    this.selectedPackage = selectedPackage;

    if (this.selectedPackage.Status === "MissingDetails") {
      const packageToUpdate = this.selectedPackage;
      const selectPkgReq: Parameters<typeof hostApi.getPackageAsync>[0] = {
        Id: packageToUpdate.Id,
        Url: this.filters.SourceUrl,
        Prerelease: this.filters.Prerelease,
      };
      if (this.CurrentSource?.Name !== undefined) selectPkgReq.SourceName = this.CurrentSource.Name;
      if (this.CurrentSource?.PasswordScriptPath !== undefined) selectPkgReq.PasswordScriptPath = this.CurrentSource.PasswordScriptPath;
      const result = await hostApi.getPackageAsync(selectPkgReq);

      if (!result.ok || !result.value.Package) {
        packageToUpdate.Status = "Error";
      } else {
        if (packageToUpdate.Version !== "") {
          result.value.Package.Version = "";
        }
        packageToUpdate.UpdatePackage(
          result.value.Package,
          result.value.SourceUrl
        );
        packageToUpdate.Status = "Detailed";
      }
    }

    this.selectedVersion = this.selectedPackage.Version;
    this.requestUpdate();
  }

  async PackagesScrollEventAsync(target: HTMLElement): Promise<void> {
    if (this.packagesLoadingInProgress || this.noMorePackages) return;
    if (
      target.scrollTop + target.getBoundingClientRect().height >
      target.scrollHeight - PACKAGE_CONTAINER_SCROLL_MARGIN
    ) {
      await this.LoadPackagesAsync(true);
    }
  }

  async ReloadInvokedAsync(
    forceReload: boolean = false
  ): Promise<void> {
    await this.LoadPackagesAsync(false, forceReload);
    await this.LoadProjectsAsync(forceReload);
    await this.reloadChildViewsAsync(forceReload);
  }

  async LoadPackagesAsync(
    append: boolean = false,
    forceReload: boolean = false
  ): Promise<void> {
    if (!append) {
      this._packagesAc?.abort();
      this._packagesAc = new AbortController();
      this.packagesPage = 0;
      this.selectedPackage = null;
      this.packages = [];
    }
    const ac = this._packagesAc ?? new AbortController();

    const buildRequest = (): Parameters<typeof hostApi.getPackagesAsync>[0] => {
      const req: Parameters<typeof hostApi.getPackagesAsync>[0] = {
        Url: this.filters.SourceUrl,
        Filter: this.filters.Query,
        Prerelease: this.filters.Prerelease,
        Skip: this.packagesPage * PACKAGE_FETCH_TAKE,
        Take: PACKAGE_FETCH_TAKE,
        ForceReload: forceReload,
        Sort: this.filters.Sort,
      };
      if (this.CurrentSource?.Name !== undefined) req.SourceName = this.CurrentSource.Name;
      if (this.CurrentSource?.PasswordScriptPath !== undefined) req.PasswordScriptPath = this.CurrentSource.PasswordScriptPath;
      return req;
    };

    this.packagesLoadingError = false;
    this.packagesLoadingInProgress = true;
    this.noMorePackages = false;

    const requestObject = buildRequest();
    const result = await hostApi.getPackagesAsync(requestObject, ac.signal);

    if (ac.signal.aborted) return;

    if (!result.ok) {
      this.packagesLoadingError = true;
      this.packagesLoadingErrorMessage = result.error;
      this.packagesLoadingInProgress = false;
    } else {
      const packagesViewModels = result.value.Packages.map(
        (x) => new PackageViewModel(x)
      );
      if (packagesViewModels.length < requestObject.Take) {
        this.noMorePackages = true;
      }
      this.packages = [...this.packages, ...packagesViewModels];
      this.packagesPage++;
      this.packagesLoadingInProgress = false;
    }
  }

  async LoadProjectsAsync(forceReload: boolean = false): Promise<void> {
    this._projectsAc?.abort();
    const ac = new AbortController();
    this._projectsAc = ac;

    this.projectsLoading = true;
    this.projectsLoadingMessage = PROJECTS_LOADING_MESSAGE;
    try {
      // The scan runs as a host job: a cold parse of a large repository has no business sitting
      // behind an RPC deadline, and the job reports the core's own per-project progress.
      const result = await runWorkspaceScanJobAsync(
        { ForceReload: forceReload },
        {
          // Aborting only stops this view waiting - the host keeps parsing and caches the result.
          signal: ac.signal,
          onProgress: ({ Stage, Percent }) => {
            if (this._projectsAc !== ac) return;
            this.projectsLoadingMessage = Percent > 0 ? `${Stage} — ${Percent}%` : Stage;
          },
        }
      );

      if (ac.signal.aborted) return;

      if (result.ok) {
        this.projects = result.value.Projects.map(
          (x) => new ProjectViewModel(x)
        );
        this._allProjectPaths = this.projects.map((p) => p.Path);
        const validPaths = new Set(this._allProjectPaths);
        this.selectedProjectPaths = this.selectedProjectPaths.filter((p) => validPaths.has(p));
        if (this.selectedProjectPaths.length === 0) {
          this.selectedProjectPaths = this._allProjectPaths;
        }
        await this.LoadProjectsPackagesAsync(forceReload);
        await this.RefreshVulnerabilityCountAsync();
      }
    } finally {
      if (this._projectsAc === ac) {
        this.projectsLoading = false;
      }
    }
  }

  // -- Render helpers --

  private renderBrowseTab(): unknown {
    return html`
      <div class="list-header">
        <div>
          <div class="list-title">Browse NuGet</div>
          <div class="list-subtitle">Search nuget.org and your configured feeds</div>
        </div>
      </div>
      <div
        class="packages-container"
        @scroll=${async (e: Event) =>
          await this.PackagesScrollEventAsync(e.target as HTMLElement)}
      >
        ${this.packagesLoadingError
          ? html`<div class="error">
              <span class="codicon codicon-error"></span>
              ${this.packagesLoadingErrorMessage || "Failed to fetch packages"}
              <button class="icon-btn" title="Retry" aria-label="Retry" @click=${async () => await this.LoadPackagesAsync()}>
                <span class="codicon codicon-refresh"></span>
              </button>
            </div>`
          : html`
              ${this.packages.map(
                (pkg) => html`
                  <package-row
                    .package=${pkg}
                    @click=${async () => await this.SelectPackageAsync(pkg)}
                  ></package-row>
                `
              )}
              ${this.renderLoader()}
            `}
      </div>
    `;
  }

  private get installedFrameworkOptions(): Array<{ value: string; label: string }> {
    const values = this.projectsPackages.map((p) => p.CpmFramework);
    return buildFrameworkOptions(values, values.some((value) => value === ""));
  }

  private get filteredInstalledPackages(): PackageViewModel[] {
    return this.projectsPackages.filter((pkg) => {
      const version = pkg.InstalledVersion;
      const isPrerelease = IsPrereleaseVersion(version);
      if (!this.filters.Prerelease && isPrerelease) return false;
      if (this._installedFramework !== "" && this.installedFrameworkOptions.length > 0) {
        return matchesFrameworkSelection(this._installedFramework, pkg.CpmFramework);
      }
      return true;
    });
  }

  private get groupedInstalledPackages(): Array<{ key: string; label: string; packages: PackageViewModel[] }> {
    const groups = new Map<string, PackageViewModel[]>();
    for (const pkg of this.filteredInstalledPackages) {
      const key = getFrameworkGroupKey(this._installedFramework, pkg.CpmFramework);
      const list = groups.get(key) ?? [];
      list.push(pkg);
      groups.set(key, list);
    }

    return [...groups.entries()]
      .map(([key, packages]) => {
        const sortedPackages = [...packages].sort((a, b) => a.Name.localeCompare(b.Name));
        return {
          key,
          label: key || "Shared",
          packages: sortedPackages,
        };
      })
      .sort((a, b) => {
        if (a.key === "" && b.key !== "") return -1;
        if (a.key !== "" && b.key === "") return 1;
        return a.key.localeCompare(b.key);
      });
  }

  private renderFrameworkSlot(): unknown {
    let options: Array<{ value: string; label: string }> = [];
    let value = "";
    let onChange: (e: Event) => void = () => {};

    if (this.activeTab === "installed" && this.installedFrameworkOptions.length > 0) {
      options = this.installedFrameworkOptions;
      value = this._installedFramework;
      onChange = (e: Event) => { this._installedFramework = (e.target as HTMLSelectElement).value; };
    } else if (this.activeTab === "updates" && this._updatesFrameworkOptions.length > 0) {
      options = this._updatesFrameworkOptions;
      value = this._updatesFramework;
      onChange = (e: Event) => { this._updatesFramework = (e.target as HTMLSelectElement).value; };
    } else if (this.activeTab === "consolidate" && this._consolidateFrameworkOptions.length > 0) {
      options = this._consolidateFrameworkOptions;
      value = this._consolidateFramework;
      onChange = (e: Event) => { this._consolidateFramework = (e.target as HTMLSelectElement).value; };
    }

    if (options.length === 0) return nothing;
    return html`
      <select slot="extra-right" aria-label="Filter by framework" .value=${value} @change=${onChange}>
        ${options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
      </select>
    `;
  }

  /** Row identity for the Installed tab: the framework line is part of the row key. */
  private installedRowKey(pkg: PackageViewModel): string {
    return `${pkg.Id}\0${pkg.CpmFramework}`;
  }

  /**
   * Builds the batch entries for one Installed row. A framework-scoped row touches only the
   * projects whose CPM resolution carries that TFM, grouped by the resolution's raw `Condition`
   * (the host needs it to target one conditional group). A shared row touches the projects with
   * an unconditional resolution — or with no CPM resolutions at all.
   */
  private buildInstalledUpdateEntries(pkg: PackageViewModel): BatchUpdateRequest["Updates"] {
    const projectsToUse =
      this.selectedProjectPaths.length > 0
        ? this.projects.filter((p) => this.selectedProjectPaths.includes(p.Path))
        : this.projects;

    const groups = new Map<string, string[]>();
    for (const project of projectsToUse) {
      const installed = project.Packages.find((p) => p.Id === pkg.Id);
      // A pinned `[x.y.z]` reference is deliberately left alone, matching the project-row update arrow.
      if (!installed || installed.IsPinned) continue;
      const resolutions = installed.CpmResolutions ?? [];
      if (pkg.CpmFramework !== "") {
        const resolution = resolutions.find((r) => r.Tfm === pkg.CpmFramework);
        // A framework-scoped row must never fall through to an unconditional write.
        if (!resolution?.Condition) continue;
        const paths = groups.get(resolution.Condition) ?? [];
        paths.push(project.Path);
        groups.set(resolution.Condition, paths);
      } else {
        if (resolutions.length > 0 && !resolutions.some((r) => r.Tfm === "")) continue;
        const paths = groups.get("") ?? [];
        paths.push(project.Path);
        groups.set("", paths);
      }
    }

    if (pkg.CpmFramework !== "") {
      return [...groups].map(([condition, projectPaths]) => ({
        PackageId: pkg.Id,
        Version: pkg.Version,
        ProjectPaths: projectPaths,
        CpmCondition: condition,
        CpmTfm: pkg.CpmFramework,
        Scope: "group" as const,
      }));
    }

    return [...groups].map(([, projectPaths]) => ({
      PackageId: pkg.Id,
      Version: pkg.Version,
      ProjectPaths: projectPaths,
      Scope: "unconditional" as const,
    }));
  }

  /**
   * Updates one Installed row to the version its arrow advertises, across the projects that
   * actually carry it. The whole write is one transactional host job: snapshot, restore and
   * rollback come for free.
   */
  async UpdateInstalledPackageAsync(pkg: PackageViewModel): Promise<void> {
    const key = this.installedRowKey(pkg);
    if (this.updatingInstalledKeys.has(key) || !pkg.Version) return;
    const Updates = this.buildInstalledUpdateEntries(pkg);
    if (Updates.length === 0) return;

    this.updatingInstalledKeys = new Set([...this.updatingInstalledKeys, key]);
    this.installedUpdateError = "";
    this.installedUpdateStatus = `Updating ${pkg.Id} to ${pkg.Version}…`;
    try {
      const result = await runBatchUpdateJobAsync({ Transactional: true, Updates });
      if (!result.ok) {
        this.installedUpdateStatus = "";
        this.installedUpdateError = `Failed to update ${pkg.Id}: ${result.error}`;
        return;
      }
      const response = result.value;
      if (response.Cancelled) {
        this.installedUpdateStatus = "";
        this.installedUpdateError = `Update of ${pkg.Id} was cancelled — the versions already written were rolled back`;
        return;
      }
      const failed = response.Results.find((r) => !r.Success);
      if (response.RolledBack || failed) {
        const reason = response.RestoreError ?? response.RollbackError ?? failed?.Error ?? "";
        const suffix = reason ? `: ${reason}` : "";
        this.installedUpdateStatus = "";
        this.installedUpdateError = response.RolledBack
          ? `Update of ${pkg.Id} was rolled back${suffix}`
          : `Failed to update ${pkg.Id}${suffix}`;
        return;
      }
      this.installedUpdateStatus = `Updated ${pkg.Id} to ${pkg.Version}`;
      await this.onPackagesUpdatedAsync();
    } finally {
      const remaining = new Set(this.updatingInstalledKeys);
      remaining.delete(key);
      this.updatingInstalledKeys = remaining;
      this.requestUpdate();
    }
  }

  /** Compact result line under the Installed header: the error, else the last status. */
  private renderInstalledUpdateStatus(): unknown {
    if (this.installedUpdateError) {
      return html`<div class="installed-update-status installed-update-error">${this.installedUpdateError}</div>`;
    }
    if (this.installedUpdateStatus) {
      return html`<div class="installed-update-status">${this.installedUpdateStatus}</div>`;
    }
    return nothing;
  }

  private renderInstalledTab(): unknown {
    const packages = this.filteredInstalledPackages;
    const groups = this.groupedInstalledPackages;
    // A single framework line has nothing to separate, so it gets no header.
    const showGroupHeaders = shouldShowFrameworkGroups(groups);

    return html`
      <div class="packages-container installed-packages">
        <div class="list-header">
          <div>
            <div class="list-title">Installed packages</div>
            <div class="list-subtitle">
              ${packages.length} package${packages.length !== 1 ? "s" : ""} across ${this.projects.length} project${this.projects.length !== 1 ? "s" : ""}
            </div>
          </div>
          <div class="list-actions">
            <button class="ghost-btn" ?disabled=${this.packagesLoadingInProgress} @click=${async () => await this.LoadProjectsAsync()}>
              Refresh
            </button>
          </div>
        </div>
        ${this.renderInstalledUpdateStatus()}
        ${packages.length === 0 && this.projectsPackages.length > 0
          ? html`
              <div class="empty">
                <span class="codicon codicon-info"></span>
                <div class="empty-title">No packages match the current filters</div>
                <div class="empty-hint">Try clearing the framework filter or enabling prerelease versions.</div>
              </div>
            `
          : groups.map(
              (group) => html`
                ${showGroupHeaders
                  ? html`
                      <div class="group-header">
                        ${group.label}
                        <span class="group-count">${group.packages.length}</span>
                      </div>
                    `
                  : nothing}
                ${group.packages.map(
                  (pkg) => html`
                    <package-row
                      class="installed-package-row"
                      .showInstalledVersion=${true}
                      .package=${pkg}
                      .revision=${pkg.Revision}
                      .updating=${this.updatingInstalledKeys.has(this.installedRowKey(pkg))}
                      @package-update-requested=${async (e: CustomEvent<{ package: PackageViewModel }>) => await this.UpdateInstalledPackageAsync(e.detail.package)}
                      @click=${async () => await this.SelectPackageAsync(pkg)}
                    ></package-row>
                  `
                )}
              `
            )}
      </div>
    `;
  }


  private async cancelRemoveAsync(): Promise<void> {
    if (!this._removeJobId) return;
    this._removeCancelled = true;
    const result = await hostApi.cancelJobAsync({ JobId: this._removeJobId });
    if (!result.ok) {
      this.removeError = `Failed to cancel: ${result.error}`;
    }
    this.requestUpdate();
  }

  private async removePackageFromAllProjectsAsync(): Promise<void> {
    const pkg = this.selectedPackage;
    if (!pkg || this.removingPackage) return;

    const targets = this.findProjectsUsing(pkg.Id);
    if (targets.length === 0) return;

    const confirm = await hostApi.showConfirmationAsync({
      Message: `Remove ${pkg.Id} from ${targets.length} project${targets.length !== 1 ? "s" : ""}?`,
      Detail: targets.map((project) => project.Name).join("\n"),
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.removingPackage = true;
    this.removeError = "";
    this._removeCancelled = false;
    this.requestUpdate();
    const errors: string[] = [];
    try {
      const cancelled = await this.uninstallFromProjectsAsync(pkg.Id, targets, errors);
      if (cancelled) {
        await this.finishCancelledRemovalAsync(errors);
        return;
      }
      await this.finishRemovalAsync(targets, errors);
    } finally {
      this._removeJobId = "";
      this._removeCancelled = false;
      this.removingPackage = false;
      this.requestUpdate();
    }
  }

  private findProjectsUsing(packageId: string): typeof this.projects {
    return this.projects.filter((project) =>
      project.Packages.some((projectPackage) => projectPackage.Id.toLowerCase() === packageId.toLowerCase())
    );
  }

  private async uninstallFromProjectsAsync(
    packageId: string,
    targets: typeof this.projects,
    errors: string[]
  ): Promise<boolean> {
    for (const project of targets) {
      if (this._removeCancelled) break;
      const result = await runProjectUpdateJobAsync({
        Type: "UNINSTALL",
        ProjectPath: project.Path,
        PackageId: packageId,
      }, {
        onStarted: (jobId) => {
          this._removeJobId = jobId;
        },
      });
      if (!result.ok) {
        errors.push(`${project.Name}: ${result.error}`);
        if (this._removeCancelled) break;
      }
    }
    return this._removeCancelled;
  }

  private async finishCancelledRemovalAsync(errors: string[]): Promise<void> {
    await this.LoadProjectsAsync();
    this.selectedPackage = null;
    this.removeError = errors.length > 0
      ? `Cancelled. ${errors.join("\n")}`
      : "Cancelled before every project was updated";
  }

  private async finishRemovalAsync(targets: typeof this.projects, errors: string[]): Promise<void> {
    const restore = await hostApi.restoreProjectsAsync({
      ProjectPaths: targets.map((project) => project.Path),
    });
    if (!restore.ok) errors.push(`Restore: ${restore.error}`);

    await this.LoadProjectsAsync();
    this.selectedPackage = null;
    if (errors.length > 0) {
      this.removeError = `Removed from some projects, but not all:\n${errors.join("\n")}`;
    }
  }

  private renderPackageTitle(): unknown {
    const nugetUrl = this.NugetOrgPackageUrl;
    if (nugetUrl != null) {
      return html`<a target="_blank" href=${nugetUrl}>
        <span class="package-link-icon codicon codicon-link-external"></span
        >${this.selectedPackage?.Name}</a
      >`;
    }
    return html`${this.selectedPackage?.Name}`;
  }

  private get selectedSourceName(): string {
    const sourceUrl = this.selectedPackage?.SourceUrl || this.filters.SourceUrl;
    if (!sourceUrl) return "";
    if (sourceUrl.startsWith(NUGET_ORG_PREFIX)) return "nuget.org";
    const source = configuration.Configuration?.Sources.find((s) => s.Url === sourceUrl);
    return source?.Name ?? "";
  }

  private get selectedPackageIconUrl(): string {
    const url = this.selectedPackage?.IconUrl;
    if (!url) return "https://nuget.org/Content/gallery/img/default-package-icon.svg";
    return url;
  }

  private renderDetailedPackage(): unknown {
    const sourceName = this.selectedSourceName;

    return html`
      <div class="package-header-panel">
        <img
          class="package-icon-large"
          alt=""
          src=${this.selectedPackageIconUrl}
          @error=${(e: Event) => {
            (e.target as HTMLImageElement).src = "https://nuget.org/Content/gallery/img/default-package-icon.svg";
          }}
        />
        <div class="package-header-info">
          <div class="package-title-row">
            <span class="package-title">${this.renderPackageTitle()}</span>
            ${this.selectedPackage?.Verified
              ? html`<span class="details-verified">✔ verified</span>`
              : nothing}
            ${this.selectedPackage?.CpmFramework
              ? html`<span class="tfm-badge">${this.selectedPackage.CpmFramework}</span>`
              : nothing}
            ${sourceName
              ? html`<span class="source-badge">
                  <span class="codicon codicon-globe"></span>
                  ${sourceName}
                </span>`
              : nothing}
          </div>
          ${this.selectedPackage?.Authors
            ? html`<span class="package-authors-row">by ${this.selectedPackage.Authors}</span>`
            : nothing}
        </div>
      </div>
      <div class="package-actions-row">
        <div class="version-selector">
          <span class="detail-label">Version</span>
          <custom-dropdown
            .options=${(this.selectedPackage?.Versions || []).map((v): DropdownOption => ({ value: v, label: v }))}
            .value=${this.selectedVersion}
            ariaLabel="Package version"
            @change=${(e: CustomEvent<string>) => { this.selectedVersion = e.detail; }}
          ></custom-dropdown>
          <button class="icon-btn" title="Refresh projects" aria-label="Refresh projects" @click=${async () => await this.LoadProjectsAsync()}>
            <span class="codicon codicon-refresh"></span>
          </button>
        </div>
        <button
          class="secondary-btn remove-all-btn"
          ?disabled=${this.removingPackage || this.projects.every((project) => !project.Packages.some((pkg) => pkg.Id.toLowerCase() === this.selectedPackage?.Id.toLowerCase()))}
          @click=${async () => await this.removePackageFromAllProjectsAsync()}
        >
          Remove from all projects
        </button>
        ${this.removingPackage
          ? html`
              <button
                class="secondary-btn"
                ?disabled=${!this._removeJobId}
                @click=${async () => await this.cancelRemoveAsync()}
              >Cancel</button>
            `
          : nothing}
      </div>
      ${this.removeError
        ? html`<div class="package-action-error" role="alert">${this.removeError}</div>`
        : nothing}
      <div class="projects-panel-container">
        <package-details
          .package=${this.selectedPackage}
          .source=${this.selectedPackage?.SourceUrl || this.filters.SourceUrl}
          .passwordScriptPath=${this.CurrentSource?.PasswordScriptPath}
          .selectedVersion=${this.selectedVersion}
        ></package-details>
        <div class="separator"></div>
        ${this.projects.length > 0
          ? this.filteredProjects.map(
              (project) => html`
                <project-row
                  @project-updated=${async (e: CustomEvent) =>
                    await this.OnProjectUpdatedAsync(e)}
                  .project=${project}
                  .packageId=${this.selectedPackage?.Name}
                  .packageVersion=${this.selectedVersion}
                  .sourceUrl=${this.selectedPackage?.SourceUrl}
                ></project-row>
              `
            )
          : html`<div class="no-projects">
              <span class="codicon codicon-info"></span> No projects found
            </div>`}
      </div>
    `;
  }

  private renderMissingDetailsPackage(): unknown {
    if (this.selectedPackage?.Status === "MissingDetails") {
      return html`<span
        class="spinner medium packages-details-loader"
      ></span>`;
    }
    return html`<div class="error">
      <span class="codicon codicon-error"></span> Failed to fetch the
      package from the selected registry.
    </div>`;
  }

  private renderSelectedPackagePanel(): unknown {
    if (this.selectedPackage == null) {
      return html`
        <div class="details-empty">
          <span class="codicon codicon-package big-icon"></span>
          <div class="title">Select a package</div>
          <div class="hint">Choose a package from Browse or Installed to see its versions, projects and actions.</div>
        </div>
      `;
    }

    if (this.selectedPackage.Status === "Detailed") {
      return this.renderDetailedPackage();
    }
    return this.renderMissingDetailsPackage();
  }

  private renderLoader(): unknown {
    return this.noMorePackages ? nothing : html`<span class="spinner medium loader"></span>`;
  }

  private renderProjectScopeSummary(): unknown {
    if (this.projectsLoading) {
      return html`<span class="scope-summary">Loading projects…</span>`;
    }
    if (this.projects.length === 0) return nothing;
    return html`<span class="scope-summary" title="Selected projects / total projects">${this.selectedProjectPaths.length}/${this.projects.length} projects</span>`;
  }

  override render(): unknown {
    return html`
      <div class="container">
        ${this.renderProjectTreeColumn()}
        <div class="col" id="packages">
          ${this.renderTabBar()}
          ${this.renderToolchainBanner()}
          ${this.renderSearchAndBanner()}
          ${this.renderActiveTab()}
        </div>
        <div class="col" id="projects">
          ${this.renderSelectedPackagePanel()}
        </div>
      </div>
      <nuget-output-log></nuget-output-log>
      <nuget-license-dialog></nuget-license-dialog>
    `;
  }

  private renderProjectTreeColumn(): unknown {
    if (!this.showProjectTree) return nothing;
    return html`<div class="col" id="project-tree">
      <project-tree
        .projects=${this.projects}
        .loading=${this.projectsLoading}
        .loadingMessage=${this.projectsLoadingMessage}
        @selection-changed=${async (e: CustomEvent<string[]>) =>
          await this.OnProjectSelectionChangedAsync(e.detail)}
      ></project-tree>
    </div>`;
  }

  /**
   * Toolchain health is checked against the discovered projects, so the banner
   * names the SDK that would actually be used for a restore.
   */
  private renderToolchainBanner(): unknown {
    return html`
      <toolchain-banner
        .projectPaths=${this.projects.map((project) => project.Path)}
        @open-toolchain=${async () => await this.setTabAsync("toolchain")}
      ></toolchain-banner>
    `;
  }

  private renderTabBar(): unknown {
    return html`
      <div class="tab-bar" role="tablist" @keydown=${async (e: KeyboardEvent) => await this.handleTabKeydownAsync(e)}>
        ${this.renderTreeToggleButton()}
        ${this.renderProjectScopeSummary()}
        ${this.renderTabButton("browse", "Browse")}
        ${this.renderTabButton("installed", "Installed", this.renderCountBadge(this.filteredInstalledPackages.length, false))}
        ${this.renderTabButton("updates", "Updates", this.renderUpdatesBadge())}
        ${this.renderTabButton("consolidate", "Consolidate", this.renderCountBadge(this.consolidateCount))}
        ${this.renderTabButton("cleanup", "Cleanup", this.renderCountBadge(this.cleanupCount), "tab-cleanup")}
        ${this.renderTabButton("vulnerabilities", "Vulnerabilities", this.renderCountBadge(this.vulnerabilitiesCount))}
        ${this.renderTabButton("toolchain", "Toolchain", this.renderCountBadge(this.toolchainCount))}
      </div>
    `;
  }

  private renderTreeToggleButton(): unknown {
    return html`
      <button
        class="icon-btn tab-tree-toggle ${this.showProjectTree ? "active" : ""}"
        title="${this.showProjectTree ? "Hide project tree" : "Show project tree"}"
        aria-label="${this.showProjectTree ? "Hide project tree" : "Show project tree"}"
        aria-pressed="${this.showProjectTree}"
        @click=${async () => await this.toggleProjectTreeAsync()}
      >
        <span class="codicon codicon-list-tree"></span>
      </button>
    `;
  }

  private renderTabButton(
    tab: TabId,
    label: string,
    badge: unknown = nothing,
    extraClass = ""
  ): unknown {
    return html`
      <button
        class="tab ${extraClass} ${this.activeTab === tab ? "active" : ""}"
        role="tab"
        aria-selected=${this.activeTab === tab}
        tabindex=${this.activeTab === tab ? 0 : -1}
        @click=${async () => await this.setTabAsync(tab)}
      >
        ${label}${badge}
      </button>
    `;
  }

  private renderCountBadge(count: number | null, showZero = true): unknown {
    if (count === null) return nothing;
    if (!showZero && count <= 0) return nothing;
    return html`<span class="tab-badge">${count}</span>`;
  }

  private renderUpdatesBadge(): unknown {
    if (this.updatesCount === null && !this.updatesCountLoading) return nothing;
    const text = this.updatesCountLoading ? "…" : this.updatesCount;
    return html`<span class="tab-badge">${text}</span>`;
  }

  private renderSearchAndBanner(): unknown {
    return html`
      <search-bar
        @reload-invoked=${async (e: CustomEvent<boolean>) =>
          await this.ReloadInvokedAsync(e.detail)}
        @filter-changed=${async (e: CustomEvent<FilterEvent>) =>
          await this.UpdatePackagesFiltersAsync(e.detail)}
      >${this.renderFrameworkSlot()}</search-bar>
      ${this.renderVulnerabilityBanner()}
    `;
  }

  private renderVulnerabilityBanner(): unknown {
    if (!this.vulnerabilitiesCount || this.vulnerabilitiesCount <= 0) return nothing;
    const vulnerabilityWord = this.vulnerabilitiesCount === 1 ? "" : "s";
    return html`<button class="vulnerability-banner" @click=${async () => await this.setTabAsync("vulnerabilities")}>
      <span class="codicon codicon-warning"></span>
      <span>${this.vulnerabilitiesCount} vulnerable package${vulnerabilityWord} found — review vulnerabilities</span>
    </button>`;
  }

  private renderActiveTab(): unknown {
    switch (this.activeTab) {
      case "browse":
        return html`<div class="tab-content" role="tabpanel" aria-label="browse tab">
          ${this.renderBrowseTab()}
        </div>`;
      case "installed":
        return html`<div class="tab-content" role="tabpanel" aria-label="installed tab">
          ${this.renderInstalledTab()}
        </div>`;
      case "updates":
        return this.renderUpdatesTab();
      case "consolidate":
        return this.renderConsolidateTab();
      case "cleanup":
        return this.renderCleanupTab();
      case "vulnerabilities":
        return this.renderVulnerabilitiesTab();
      case "toolchain":
        return this.renderToolchainTab();
      default:
        return nothing;
    }
  }

  private renderUpdatesTab(): unknown {
    return html`<div class="tab-content" role="tabpanel" aria-label="updates tab">
      <updates-view
        .prerelease=${this.filters.Prerelease}
        .projectPaths=${this.effectiveProjectPaths}
        .sourceUrl=${this.filters.SourceUrl}
        .filterQuery=${this.filters.Query}
        .availableFrameworks=${this.installedFrameworkOptions}
        .selectedFramework=${this._updatesFramework}
        @count-changed=${(e: CustomEvent<number>) => { this.updatesCount = e.detail; }}
        @badge-changed=${async (e: CustomEvent<{ Count: number; BlockedCount: number }>) =>
          await this.OnUpdatesBadgeChangedAsync(e)}
        @scan-finished=${() => { this.updatesCountLoading = false; }}
        @packages-updated=${async () => await this.onPackagesUpdatedAsync()}
        @package-selected=${(e: CustomEvent) => void this.onChildPackageSelectedAsync(e)}
        @framework-options-changed=${(e: CustomEvent<Array<{ value: string; label: string }>>) => {
          this._updatesFrameworkOptions = e.detail;
          this._updatesFramework = "";
        }}
        @framework-changed=${(e: CustomEvent<string>) => {
          this._updatesFramework = e.detail;
        }}
      ></updates-view>
    </div>`;
  }

  private renderConsolidateTab(): unknown {
    return html`<div class="tab-content" role="tabpanel" aria-label="consolidate tab">
      <consolidate-view
        .projectPaths=${this.effectiveProjectPaths}
        .selectedFramework=${this._consolidateFramework}
        @count-changed=${(e: CustomEvent<number>) => { this.consolidateCount = e.detail; }}
        @package-selected=${(e: CustomEvent) => void this.onChildPackageSelectedAsync(e)}
        @framework-options-changed=${(e: CustomEvent<Array<{ value: string; label: string }>>) => {
          const previousFramework = this._consolidateFramework;
          this._consolidateFrameworkOptions = e.detail;
          const isStillValid = !!previousFramework && e.detail.some(option => option.value === previousFramework);
          this._consolidateFramework = isStillValid ? previousFramework : "";
        }}
      ></consolidate-view>
    </div>`;
  }

  private renderCleanupTab(): unknown {
    return html`<div class="tab-content" role="tabpanel" aria-label="cleanup tab">
      <cleanup-view
        .projectPaths=${this.effectiveProjectPaths}
        @count-changed=${(e: CustomEvent<number>) => { this.cleanupCount = e.detail; }}
        @cleanup-completed=${async () => {
          await this.LoadProjectsAsync();
        }}
      ></cleanup-view>
    </div>`;
  }

  private renderToolchainTab(): unknown {
    return html`<div class="tab-content" role="tabpanel" aria-label="toolchain tab">
      <toolchain-view
        .projectPaths=${this.effectiveProjectPaths}
        @count-changed=${(e: CustomEvent<number>) => { this.toolchainCount = e.detail; }}
      ></toolchain-view>
    </div>`;
  }

  private renderVulnerabilitiesTab(): unknown {
    return html`<div class="tab-content" role="tabpanel" aria-label="vulnerabilities tab">
      <vulnerabilities-view
        .projectPaths=${this.effectiveProjectPaths}
        @count-changed=${(e: CustomEvent<number>) => { this.vulnerabilitiesCount = e.detail; }}
        @package-selected=${(e: CustomEvent) => void this.onChildPackageSelectedAsync(e)}
      ></vulnerabilities-view>
    </div>`;
  }
}
