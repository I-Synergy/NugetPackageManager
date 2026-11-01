import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { configuration, router } from "./registrations";
import type { PackagesView } from "./components/packages-view";

// Import all Lit components (they self-register via @customElement)
import "./components/packages-view";
import "./components/package-row";
import "./components/project-row";
import "./components/settings-view";
import "./components/package-details";
import "./components/search-bar";
import "./components/updates-view";
import "./components/consolidate-view";
import "./components/cleanup-view";
import "./components/vulnerabilities-view";
import "./components/project-tree";
import "./components/nuget-output-log";
import "./components/nuget-license-dialog";

import "./main.css";

type HostCommand =
  | { type: "command"; command: "search"; query: string }
  | { type: "command"; command: "navigate-tab"; tab: string }
  | { type: "command"; command: "navigate-route"; route: string }
  | { type: "command"; command: "reload-configuration" };

@customElement("nuget-package-manager")
export class NuGetPackageManager extends LitElement {
  @state() private configLoaded = configuration.Configuration != null;
  @state() private currentRoute = router.CurrentRoute;
  @state() private currentConfiguration = configuration.Configuration;

  private readonly onConfigChanged = () => {
    this.currentConfiguration = configuration.Configuration;
    this.configLoaded = this.currentConfiguration != null;
  };
  private readonly onRouteChanged = () => { this.currentRoute = router.CurrentRoute; };
  private readonly onMessage = (event: MessageEvent) => {
    const data = event.data as HostCommand;
    if (data?.type !== "command") return;
    this.handleHostCommand(data);
  };

  override connectedCallback() {
    super.connectedCallback();
    configuration.addEventListener("configuration-changed", this.onConfigChanged);
    router.addEventListener("route-changed", this.onRouteChanged);
    window.addEventListener("message", this.onMessage);
    void configuration.ReloadAsync();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    configuration.removeEventListener("configuration-changed", this.onConfigChanged);
    router.removeEventListener("route-changed", this.onRouteChanged);
    window.removeEventListener("message", this.onMessage);
  }

  private handleHostCommand(cmd: HostCommand): void {
    switch (cmd.command) {
      case "search": {
        router.Navigate("BROWSE");
        void this.updateComplete.then(async () => {
          const packagesView = this.shadowRoot?.querySelector("packages-view") as PackagesView | null;
          await packagesView?.setSearchQueryAsync(cmd.query);
        });
        break;
      }
      case "navigate-tab": {
        router.Navigate("BROWSE");
        void this.updateComplete.then(async () => {
          const packagesView = this.shadowRoot?.querySelector("packages-view") as PackagesView | null;
          await packagesView?.setTabAsync(cmd.tab as "browse" | "installed" | "updates" | "consolidate" | "vulnerabilities");
        });
        break;
      }
      case "navigate-route": {
        router.Navigate(cmd.route as "BROWSE" | "SETTINGS");
        break;
      }
      case "reload-configuration": {
        void configuration.ReloadAsync();
        break;
      }
    }
  }

  override render() {
    if (!this.configLoaded) {
      return html``;
    }
    if (this.currentRoute === "SETTINGS") {
      return html`<settings-view .configuration=${this.currentConfiguration}></settings-view>`;
    }
    return html`<packages-view .configuration=${this.currentConfiguration}></packages-view>`;
  }
}
