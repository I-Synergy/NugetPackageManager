import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import codicon from "@/web/styles/codicon.css";

export interface DropdownOption {
  value: string;
  label: string;
}

@customElement("custom-dropdown")
export class CustomDropdown extends LitElement {
  static override readonly styles = [
    codicon,
    css`
      :host {
        display: inline-block;
        position: relative;
      }

      .dropdown-trigger {
        display: flex;
        align-items: center;
        gap: 4px;
        background-color: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border);
        padding: 4px 8px;
        font-size: inherit;
        font-family: inherit;
        border-radius: 2px;
        cursor: pointer;
        outline: none;
        white-space: nowrap;
        min-width: 0;
      }

      .dropdown-trigger:focus {
        border-color: var(--vscode-focusBorder);
      }

      .dropdown-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: left;
      }

      .dropdown-chevron {
        flex-shrink: 0;
        font-size: 10px;
        opacity: 0.7;
      }

      .dropdown-menu {
        position: fixed;
        max-height: 200px;
        overflow-y: auto;
        z-index: 9999;
        background-color: var(--vscode-dropdown-listBackground, var(--vscode-dropdown-background));
        border: 1px solid var(--vscode-dropdown-border);
        border-radius: 2px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }

      .dropdown-option {
        padding: 4px 8px;
        cursor: pointer;
        white-space: nowrap;
        font-size: inherit;
        color: var(--vscode-dropdown-foreground);
      }

      .dropdown-option:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .dropdown-option.selected {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }
    `,
  ];

  @property({ attribute: false }) options: DropdownOption[] = [];
  @property() value: string = "";
  @property() override ariaLabel: string = "";

  @state() private open: boolean = false;
  @state() private _menuTop: number = 0;
  @state() private _menuRight: number = 0;
  @state() private _menuMinWidth: number = 0;

  private get selectedLabel(): string {
    return this.options.find((o) => o.value === this.value)?.label ?? this.value;
  }

  private computeMenuPosition(): void {
    const trigger = this.shadowRoot?.querySelector(".dropdown-trigger");
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    this._menuTop = rect.bottom;
    this._menuRight = window.innerWidth - rect.right;
    this._menuMinWidth = rect.width;
  }

  private toggle(): void {
    this.open = !this.open;
    if (this.open) {
      this.computeMenuPosition();
      this.addOutsideClickListener();
      window.addEventListener("scroll", this._closeHandler, true);
      window.addEventListener("resize", this._closeHandler);
    } else {
      this.removeListeners();
    }
  }

  private select(value: string): void {
    this.open = false;
    this.removeListeners();
    if (value !== this.value) {
      this.value = value;
      this.dispatchEvent(
        new CustomEvent("change", {
          detail: value,
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      this.open = false;
      this.removeListeners();
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === " ") {
      this.toggle();
      e.preventDefault();
    } else if (!this.open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      this.open = true;
      this.computeMenuPosition();
      this.addOutsideClickListener();
      window.addEventListener("scroll", this._closeHandler, true);
      window.addEventListener("resize", this._closeHandler);
      e.preventDefault();
    }
  }

  private readonly _closeHandler = () => {
    this.open = false;
    this.removeListeners();
  };

  private readonly _outsideClickHandler = (e: MouseEvent) => {
    const path = e.composedPath();
    if (!path.includes(this)) {
      this.open = false;
      this.removeListeners();
    }
  };

  private addOutsideClickListener(): void {
    document.addEventListener("click", this._outsideClickHandler, true);
  }

  private removeListeners(): void {
    document.removeEventListener("click", this._outsideClickHandler, true);
    window.removeEventListener("scroll", this._closeHandler, true);
    window.removeEventListener("resize", this._closeHandler);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeListeners();
  }

  override render(): unknown {
    return html`
      <button
        class="dropdown-trigger"
        role="combobox"
        aria-expanded=${this.open}
        aria-haspopup="listbox"
        aria-label=${this.ariaLabel}
        @click=${() => this.toggle()}
        @keydown=${(e: KeyboardEvent) => this.onKeydown(e)}
      >
        <span class="dropdown-label">${this.selectedLabel}</span>
        <span class="dropdown-chevron codicon codicon-chevron-down"></span>
      </button>
      ${this.open
        ? html`
            <div
              class="dropdown-menu"
              role="listbox"
              style="top:${this._menuTop}px; right:${this._menuRight}px; min-width:${this._menuMinWidth}px;"
            >
              ${this.options.map(
                (opt) => html`
                  <div
                    class="dropdown-option ${opt.value === this.value ? "selected" : ""}"
                    role="option"
                    aria-selected=${opt.value === this.value}
                    @click=${() => this.select(opt.value)}
                  >
                    ${opt.label}
                  </div>
                `
              )}
            </div>
          `
        : nothing}
    `;
  }
}
