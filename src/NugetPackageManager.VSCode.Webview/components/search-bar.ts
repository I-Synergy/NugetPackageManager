import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import codicon from "@/web/styles/codicon.css";
import { sharedStyles } from "@/web/styles/shared.css";
import { configuration, hostApi } from "../registrations";
import type { DropdownOption } from "./dropdown";
import "./dropdown";
import debounce from "lodash/debounce";

const styles = css`
  .search-bar {
    display: flex;
    gap: 10px;
    justify-content: space-between;
    align-items: center;
    margin: 8px 8px 0;
    padding: 8px;
    border: 1px solid var(--npm-border, var(--vscode-panelSection-border));
    border-radius: var(--npm-radius, 10px);
    background: var(--npm-surface-raised, var(--vscode-editorWidget-background));
    flex-wrap: wrap;

    .search-bar-left {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;

      .search-input-wrapper {
        position: relative;
        flex: 1;
        max-width: 340px;
        min-width: 140px;
        display: flex;
        align-items: center;

        .search-input {
          width: 100%;
          background: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          padding: 4px 24px 4px 8px;
          font-size: inherit;
          font-family: inherit;
          outline: none;
        }

        .search-input:focus {
          border-color: var(--vscode-focusBorder);
        }

        .search-clear {
          position: absolute;
          right: 4px;
          display: flex;
          align-items: center;
          padding: 0;
          background: none;
          border: none;
          cursor: pointer;
          color: var(--vscode-input-foreground);
          opacity: 0.6;
          font-size: 12px;
          line-height: 1;

          &:hover {
            opacity: 1;
          }
        }
      }

      .checkbox-label {
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        white-space: nowrap;
      }
    }

    .search-bar-right {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
  }
`;

export type SortOption = "relevance" | "downloads" | "recent" | "name-asc";

export type FilterEvent = {
  Query: string;
  Prerelease: boolean;
  SourceUrl: string;
  Sort: SortOption;
};

@customElement("search-bar")
export class SearchBar extends LitElement {
  static override readonly styles = [codicon, sharedStyles, styles];

  private readonly delayedPackagesLoader = debounce(() => this.emitFilterChangedEvent(), 500);
  @state() prerelease: boolean = false;
  @state() filterQuery: string = "";
  @state() selectedSourceUrl: string = "";
  @state() sortBy: SortOption = "relevance";

  override connectedCallback(): void {
    super.connectedCallback();
    this.selectedSourceUrl = "";
    this.prerelease = configuration.Configuration?.Prerelease ?? false;
    this.emitFilterChangedEvent();
  }

  private async prereleaseChangedEventAsync(target: EventTarget): Promise<void> {
    this.prerelease = (target as HTMLInputElement).checked;
    this.emitFilterChangedEvent();
    await this.savePrereleaseToConfigurationAsync();
  }

  private async savePrereleaseToConfigurationAsync(): Promise<void> {
    const config = configuration.Configuration;
    if (!config) return;

    configuration.UpdateLocalPrerelease(this.prerelease);
    await hostApi.updateConfigurationAsync({
      Configuration: {
        SkipRestore: config.SkipRestore,
        EnablePackageVersionInlineInfo: config.EnablePackageVersionInlineInfo,
        Prerelease: this.prerelease,
        Sources: config.Sources,
        StatusBarLoadingIndicator: config.StatusBarLoadingIndicator,
      },
    });
  }

  private filterInputEvent(target: EventTarget): void {
    this.filterQuery = (target as HTMLInputElement).value;
    this.delayedPackagesLoader();
  }

  private selectSource(value: string): void {
    this.selectedSourceUrl = value;
    this.emitFilterChangedEvent();
  }

  private sortChanged(value: string): void {
    const valid: SortOption[] = ["relevance", "downloads", "recent", "name-asc"];
    if (!valid.includes(value as SortOption)) return;
    this.sortBy = value as SortOption;
    this.emitFilterChangedEvent();
  }

  private get sortOptions(): DropdownOption[] {
    return [
      { value: "relevance", label: "Relevance" },
      { value: "downloads", label: "Downloads" },
      { value: "recent", label: "Recently Updated" },
      { value: "name-asc", label: "Name A-Z" },
    ];
  }

  private get sourceOptions(): DropdownOption[] {
    const sources = configuration.Configuration?.Sources ?? [];
    return [
      { value: "", label: "All sources" },
      ...sources.map((s) => ({ value: s.Url, label: s.Name })),
    ];
  }

  setSearchQuery(query: string): void {
    this.filterQuery = query;
    const input = this.shadowRoot?.querySelector(".search-input") as HTMLInputElement;
    if (input) input.value = query;
    this.emitFilterChangedEvent();
  }

  private clearSearch(): void {
    this.filterQuery = "";
    const input = this.shadowRoot?.querySelector(".search-input") as HTMLInputElement;
    if (input) input.value = "";
    this.emitFilterChangedEvent();
  }

  private reloadClicked(): void {
    const forceReload = true;
    this.dispatchEvent(
      new CustomEvent("reload-invoked", {
        detail: forceReload,
        bubbles: true,
        composed: true,
      })
    );
  }

  private emitFilterChangedEvent(): void {
    const filterEvent: FilterEvent = {
      Query: this.filterQuery,
      Prerelease: this.prerelease,
      SourceUrl: this.selectedSourceUrl,
      Sort: this.sortBy,
    };
    this.dispatchEvent(
      new CustomEvent("filter-changed", {
        detail: filterEvent,
        bubbles: true,
        composed: true,
      })
    );
  }

  override render() {
    return html`
      <div class="search-bar">
        <div class="search-bar-left">
          <div class="search-input-wrapper">
            <input
              type="text"
              class="search-input"
              placeholder="Search packages..."
              aria-label="Search packages"
              @input=${(e: Event) => this.filterInputEvent(e.target!)}
            />
            ${this.filterQuery
              ? html`<button class="search-clear" aria-label="Clear search" title="Clear" @click=${() => this.clearSearch()}>
                  <span class="codicon codicon-close"></span>
                </button>`
              : nothing}
          </div>
          <button class="icon-btn" aria-label="Reload packages" title="Reload" @click=${() => this.reloadClicked()}>
            <span class="codicon codicon-refresh"></span>
          </button>
          <label class="checkbox-label">
            <input
              type="checkbox"
              .checked=${this.prerelease}
              @change=${async (e: Event) => await this.prereleaseChangedEventAsync(e.target!)}
            />
            Prerelease
          </label>
        </div>
        <div class="search-bar-right">
          <slot name="extra-right"></slot>
          <custom-dropdown
            .options=${this.sortOptions}
            .value=${this.sortBy}
            ariaLabel="Sort by"
            @change=${(e: CustomEvent<string>) => this.sortChanged(e.detail)}
          ></custom-dropdown>
          <custom-dropdown
            .options=${this.sourceOptions}
            .value=${this.selectedSourceUrl}
            ariaLabel="Package source"
            @change=${(e: CustomEvent<string>) => this.selectSource(e.detail)}
          ></custom-dropdown>
        </div>
      </div>
    `;
  }
}
