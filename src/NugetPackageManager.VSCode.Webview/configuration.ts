import type { HostAPI } from "@/common/rpc/types";

export default class ConfigurationService extends EventTarget {
  private readonly hostApi: HostAPI;
  private configuration: Configuration | null = null;

  constructor(hostApi: HostAPI) {
    super();
    this.hostApi = hostApi;
  }

  get Configuration(): Configuration | null {
    return this.configuration;
  }

  async ReloadAsync() {
    const result = await this.hostApi.getConfigurationAsync();
    if (result.ok) {
      this.configuration = result.value.Configuration;
    }
    this.dispatchEvent(new Event("configuration-changed"));
  }

  UpdateLocalPrerelease(value: boolean): void {
    if (this.configuration) {
      this.configuration = { ...this.configuration, Prerelease: value };
    }
    this.dispatchEvent(new Event("configuration-changed"));
  }

  UpdateLocal(patch: Partial<Configuration>): void {
    if (this.configuration) {
      this.configuration = { ...this.configuration, ...patch };
    }
    this.dispatchEvent(new Event("configuration-changed"));
  }
}
