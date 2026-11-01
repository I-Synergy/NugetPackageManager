import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { hostApi } from "@/web/registrations";
import type { InstalledSdkInfo } from "@/common/rpc/types";
import type { DropdownOption } from "./dropdown";
import "./dropdown";

/**
 * SDK selector. Choosing a version writes it into the workspace's `global.json`
 * — the file `dotnet` itself reads — so the pin is versioned with the repository
 * instead of living in `settings.json`. When no `global.json` exists, one is
 * created at the workspace root.
 *
 * When the pinned version is not installed, the component offers to install it
 * with Microsoft's official `dotnet-install` script (confirmed by the user,
 * trusted workspace only, installed under the user profile).
 */
@customElement("sdk-select")
export class SdkSelect extends LitElement {
  static override readonly styles = [
    css`
      :host {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }

      .label {
        color: var(--vscode-descriptionForeground);
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

      button:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .feedback {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        overflow-wrap: anywhere;
      }
    `,
  ];

  @property({ attribute: false }) sdks: InstalledSdkInfo[] = [];
  /** The version pinned in the workspace's `global.json`. */
  @property({ type: String }) selected = "";
  /** Version that would fix the current issue; enables the install action. */
  @property({ type: String }) recommended = "";
  /** Projects whose nearest `global.json` is updated. */
  @property({ attribute: false }) projectPaths: string[] = [];

  @state() private busy = false;
  @state() private feedback = "";

  private isInstalled(version: string): boolean {
    return this.sdks.some(
      (sdk) => sdk.Version === version || sdk.Version.startsWith(`${version}.`)
    );
  }

  private buildOptions(): DropdownOption[] {
    const options: DropdownOption[] = [];
    for (const sdk of this.sdks) {
      options.push({
        value: sdk.Version,
        label: sdk.Source === "private" ? `${sdk.Version} (installed by extension)` : sdk.Version,
      });
    }
    if (this.selected && !this.isInstalled(this.selected)) {
      options.push({ value: this.selected, label: `${this.selected} (not installed)` });
    }
    if (options.length === 0) {
      options.push({ value: "", label: "No .NET SDK found" });
    }
    return options;
  }

  private async onSelectAsync(event: CustomEvent<string>): Promise<void> {
    const version = event.detail;
    if (!version || version === this.selected) return;

    this.busy = true;
    this.feedback = "";
    const result = await hostApi.setWorkspaceSdkAsync({
      Version: version,
      ProjectPaths: this.projectPaths,
    });
    this.busy = false;
    if (!result.ok) {
      this.feedback = result.error;
      return;
    }
    this.selected = result.value.Version;
    const notes = result.value.Notes.length > 0 ? ` — ${result.value.Notes.join("; ")}` : "";
    this.feedback = `global.json updated (${result.value.GlobalJsonPath})${notes}`;
    this.dispatchEvent(new CustomEvent("sdk-changed", { bubbles: true, composed: true }));
  }

  private async onInstallAsync(): Promise<void> {
    const version = this.recommended;
    if (!version) return;

    const confirm = await hostApi.showConfirmationAsync({
      Message: `Install .NET SDK ${version}?`,
      Detail:
        `Downloads Microsoft's dotnet-install script and installs SDK ${version} under your user profile. ` +
        "The extension then pins it in global.json for this workspace.",
    });
    if (!confirm.ok || !confirm.value.Confirmed) return;

    this.busy = true;
    this.feedback = `Installing ${version}…`;
    const result = await hostApi.installSdkAsync({ Version: version });
    this.busy = false;
    if (!result.ok) {
      this.feedback = `Install failed: ${result.error}`;
      return;
    }
    this.feedback = `Installed ${version}.`;
    this.selected = version;
    this.dispatchEvent(new CustomEvent("sdk-changed", { bubbles: true, composed: true }));
  }

  override render(): unknown {
    const installable = this.recommended !== "" && !this.isInstalled(this.recommended);

    return html`
      <span class="label">global.json SDK</span>
      <custom-dropdown
        .options=${this.buildOptions()}
        .value=${this.selected}
        .ariaLabel=${"dotnet SDK pinned in global.json"}
        @change=${async (event: CustomEvent<string>) => await this.onSelectAsync(event)}
      ></custom-dropdown>
      ${installable
        ? html`<button
            ?disabled=${this.busy}
            @click=${async () => await this.onInstallAsync()}
          >Install ${this.recommended}</button>`
        : nothing}
      ${this.feedback ? html`<span class="feedback" role="status">${this.feedback}</span>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sdk-select": SdkSelect;
  }
}
