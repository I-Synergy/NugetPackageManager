import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import codicon from "@/web/styles/codicon.css";
import { scrollableBase } from "@/web/styles/base.css";
import { ProjectViewModel } from "../types";

const styles = css`
  .tree-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    font-size: 12px;

    .tree-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panelSection-border);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);

      .header-label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .header-count {
        margin-left: auto;
        font-size: 10px;
        letter-spacing: 0;
        padding: 1px 6px;
        border-radius: 8px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
    }

    .tree-list {
      overflow-y: auto;
      flex: 1;
    }

    .loading-state {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;

      .codicon {
        font-size: 14px;
      }
    }

    .empty-state {
      padding: 16px 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .tree-item {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 8px;
      margin: 2px 6px;
      border-radius: 8px;
      cursor: default;

      &:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .codicon {
        font-size: 14px;
        color: var(--vscode-descriptionForeground);
        flex-shrink: 0;
      }

      .item-label {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 11px;
      }

      .item-meta {
        font-size: 9px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
        margin-left: auto;
      }
    }
  }
`;

@customElement("project-tree")
export class ProjectTree extends LitElement {
  static override readonly styles = [codicon, scrollableBase, styles];

  @property({ type: Array }) projects: ProjectViewModel[] = [];
  @property({ type: Boolean }) loading: boolean = false;
  @property({ type: String }) loadingMessage: string = "Discovering projects…";
  @state() selectedPaths: string[] = [];
  @state() allChecked: boolean = true;
  @state() isIndeterminate: boolean = false;

  override updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("projects")) {
      const previousSelection = new Set(this.selectedPaths);
      this.selectedPaths = previousSelection.size === 0
        ? this.projects.map((p) => p.Path)
        : this.projects.filter((p) => previousSelection.has(p.Path)).map((p) => p.Path);
      this.syncCheckboxState();
      if (previousSelection.size > 0) {
        this.emitSelectionChanged();
      }
    }
    if (changedProperties.has("selectedPaths")) {
      this.syncCheckboxState();
    }
  }

  private syncCheckboxState(): void {
    const total = this.projects.length;
    const selected = this.selectedPaths.length;
    this.allChecked = total > 0 && selected === total;
    this.isIndeterminate = selected > 0 && selected < total;
  }

  OnSelectAllChanged(_checked: boolean): void {
    if (this.allChecked) {
      this.selectedPaths = [];
    } else {
      this.selectedPaths = this.projects.map((p) => p.Path);
    }
    this.emitSelectionChanged();
  }

  OnItemChanged(path: string, checked: boolean): void {
    if (checked) {
      this.selectedPaths = [...this.selectedPaths, path];
    } else {
      this.selectedPaths = this.selectedPaths.filter((p) => p !== path);
    }
    this.emitSelectionChanged();
  }

  private emitSelectionChanged(): void {
    this.dispatchEvent(
      new CustomEvent("selection-changed", {
        detail: this.selectedPaths,
        bubbles: true,
        composed: true,
      })
    );
  }

  override render() {
    const items = this.renderItems();
    return html`
      <div class="tree-container" role="group" aria-label="Project selection">
        <div class="tree-header">
          <input
            type="checkbox"
            aria-label="Select all projects"
            .checked=${this.allChecked}
            .indeterminate=${this.isIndeterminate}
            @change=${(e: Event) =>
              this.OnSelectAllChanged((e.target as HTMLInputElement).checked)}
          />
          <span class="header-label">Projects</span>
          <span class="header-count">${this.loading ? "…" : `${this.selectedPaths.length}/${this.projects.length}`}</span>
        </div>
        <div class="tree-list" role="list" aria-busy=${this.loading}>
          ${this.renderListState()}
          ${items}
        </div>
      </div>
    `;
  }

  private renderListState(): unknown {
    if (this.loading) {
      return html`<div class="loading-state" role="status" aria-live="polite">
        <span class="codicon codicon-loading codicon-modifier-spin"></span>
        <span>${this.loadingMessage}</span>
      </div>`;
    }
    if (this.projects.length === 0) {
      return html`<div class="empty-state">No projects found</div>`;
    }
    return nothing;
  }

  private renderItems(): unknown {
    if (this.loading) return nothing;
    return this.projects.map(
      (p) => html`
        <div class="tree-item" role="listitem">
          <input
            type="checkbox"
            aria-label="Select ${p.Name}"
            .checked=${this.selectedPaths.includes(p.Path)}
            @change=${(e: Event) =>
              this.OnItemChanged(
                p.Path,
                (e.target as HTMLInputElement).checked
              )}
          />
          <span class="codicon codicon-file-code"></span>
          <span class="item-label" title=${p.Path}>${p.Name}</span>
          ${p.TargetFrameworks?.length
            ? html`<span class="item-meta">${p.TargetFrameworks.join(" · ")}</span>`
            : nothing}
        </div>
      `
    );
  }
}
