import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import codicon from "@/web/styles/codicon.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { hostApi } from "../registrations";
import { runProjectUpdateJobAsync } from "@/web/jobs";
import { ProjectPackageViewModel, ProjectViewModel } from "../types";
import type { UpdateProjectRequest } from "@/common/rpc/types";

const styles = css`
  .project-row {
    margin: 2px;
    padding: 3px;
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: space-between;
    cursor: default;

    &:hover {
      background-color: var(--vscode-list-hoverBackground);
    }

    .project-title {
      overflow: hidden;
      text-overflow: ellipsis;
      .name {
        font-weight: bold;
      }
    }

    .project-actions {
      display: flex;
      gap: 3px;
      align-items: center;

      .spinner {
        margin: 3px;
      }
    }
  }

  .row-error {
    color: var(--vscode-errorForeground);
    font-size: 10px;
    padding: 0 4px 2px;
  }
`;

@customElement("project-row")
export class ProjectRow extends LitElement {
  static override readonly styles = [codicon, sharedStyles, styles];

  @property({ type: Object }) project!: ProjectViewModel;
  @property() packageId!: string;
  @property() packageVersion!: string;
  @property() sourceUrl!: string;
  @state() private readonly loaders = new Map<string, boolean>();
  @state() private errorMessage = "";

  get projectPackage() {
    return this.project.Packages.find((x) => x.Id === this.packageId);
  }

  private _jobId: string = "";

  private async cancelJobAsync(): Promise<void> {
    if (!this._jobId) return;
    const result = await hostApi.cancelJobAsync({ JobId: this._jobId });
    if (!result.ok) {
      this.errorMessage = `Failed to cancel: ${result.error}`;
      this.requestUpdate();
    }
  }

  private async updateAsync(type: "INSTALL" | "UNINSTALL" | "UPDATE"): Promise<void> {
    if (this.loaders.get(this.packageId) === true) return;

    if (type === "UNINSTALL") {
      const confirm = await hostApi.showConfirmationAsync({
        Message: `Uninstall ${this.packageId}?`,
        Detail: `This will remove ${this.packageId} from ${this.project.Name}.`,
      });
      if (!confirm.ok || !confirm.value.Confirmed) return;
    }

    const matchingResolution = this.projectPackage?.CpmResolutions?.find(
      (resolution) => resolution.Version === this.packageVersion
    ) ?? (this.projectPackage?.CpmResolutions?.length === 1
      ? this.projectPackage.CpmResolutions[0]
      : undefined);

    const request: UpdateProjectRequest = {
      Type: type,
      ProjectPath: this.project.Path,
      PackageId: this.packageId,
      Version: this.packageVersion,
      SourceUrl: this.sourceUrl,
      ...(matchingResolution?.Condition ? { CpmCondition: matchingResolution.Condition } : {}),
      ...(matchingResolution?.Tfm ? { CpmTfm: matchingResolution.Tfm } : {}),
    };

    this.loaders.set(request.PackageId, true);
    this.errorMessage = "";
    this.requestUpdate();

    try {
      const result = await runProjectUpdateJobAsync(request, {
        onStarted: (jobId) => {
          this._jobId = jobId;
          this.requestUpdate();
        },
      });

      if (result.ok) {
        this.project.Packages = result.value.Project.Packages.map(
          (x) => new ProjectPackageViewModel(x)
        );
        this.dispatchEvent(
          new CustomEvent("project-updated", {
            detail: { isCpmEnabled: result.value.IsCpmEnabled },
            bubbles: true,
            composed: true,
          })
        );
      } else {
        this.errorMessage = result.error;
      }
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      this._jobId = "";
      this.loaders.delete(request.PackageId);
      this.requestUpdate();
    }
  }

  private renderActions() {
    if (this.loaders.get(this.packageId) === true) {
      return html`
        <span class="spinner medium" role="status" aria-label="Loading"></span>
        <button
          class="icon-btn"
          aria-label="Cancel"
          title="Cancel and roll back this operation"
          ?disabled=${!this._jobId}
          @click=${async () => await this.cancelJobAsync()}
        >
          <span class="codicon codicon-close"></span>
        </button>
      `;
    }

    const pkg = this.projectPackage;
    const version = pkg?.Version;

    if (pkg === undefined) {
      return html`
        <button class="icon-btn" aria-label="Install package" title="Install" @click=${async () => { await this.updateAsync("INSTALL"); }}>
          <span class="codicon codicon-diff-added"></span>
        </button>
      `;
    }

    const showUpdate =
      version !== this.packageVersion &&
      version !== undefined &&
      !pkg.IsPinned;

    return html`
      <span class="version">${version}</span>
      ${showUpdate
        ? html`
            <button class="icon-btn" aria-label="Update package" title="Update" @click=${async () => { await this.updateAsync("UPDATE"); }}>
              <span class="codicon codicon-arrow-circle-up"></span>
            </button>
          `
        : nothing}
      <button class="icon-btn" aria-label="Uninstall package" title="Uninstall" @click=${async () => { await this.updateAsync("UNINSTALL"); }}>
        <span class="codicon codicon-diff-removed"></span>
      </button>
    `;
  }

  override render() {
    return html`
      <div class="project-row">
        <div class="project-title">
          <span class="name">${this.project.Name}</span>
        </div>
        <div class="project-actions">${this.renderActions()}</div>
      </div>
      ${this.errorMessage
        ? html`<div class="row-error" role="alert" title=${this.errorMessage}>${this.errorMessage}</div>`
        : nothing}
    `;
  }
}
