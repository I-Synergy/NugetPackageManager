import type { Webview } from "vscode";
import type { HostAPI, RpcRequest, RpcResponse, RpcCancel } from "./types";
import type { Result } from "./result";
import { fail } from "./result";
import { Logger } from "../logger";

export class RpcHost {
  private readonly webview: Webview;
  private readonly api: HostAPI;
  private readonly inFlight = new Map<number, AbortController>();

  constructor(webview: Webview, api: HostAPI) {
    this.webview = webview;
    this.api = api;
    this.webview.onDidReceiveMessage((msg) => this.handleMessageAsync(msg));
  }

  private async handleMessageAsync(msg: unknown): Promise<void> {
    if (this.isRpcCancel(msg)) {
      this.inFlight.get(msg.id)?.abort();
      this.inFlight.delete(msg.id);
      return;
    }

    if (!this.isRpcRequest(msg)) return;

    const { id, method, params } = msg;
    const ac = new AbortController();
    this.inFlight.set(id, ac);

    let result: Result<unknown>;

    try {
      const handler = this.api[method as keyof HostAPI] as
        | ((req: unknown, signal?: AbortSignal) => Promise<Result<unknown>>)
        | undefined;

      if (!handler) {
        result = fail(`Unknown RPC method: ${method}`);
      } else {
        result = await handler.call(this.api, params, ac.signal);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error(`RPC handler error for ${method}: ${message}`);
      result = fail(`Internal error in ${method}: ${message}`);
    } finally {
      this.inFlight.delete(id);
    }

    // If the request was cancelled, don't send a response
    if (ac.signal.aborted) return;

    const response: RpcResponse = { type: "rpc-response", id, result };
    this.webview.postMessage(response);
  }

  private isRpcCancel(msg: unknown): msg is RpcCancel {
    return (
      typeof msg === "object" &&
      msg !== null &&
      (msg as RpcCancel).type === "rpc-cancel" &&
      typeof (msg as RpcCancel).id === "number"
    );
  }

  private isRpcRequest(msg: unknown): msg is RpcRequest {
    return (
      typeof msg === "object" &&
      msg !== null &&
      (msg as RpcRequest).type === "rpc-request" &&
      typeof (msg as RpcRequest).id === "number" &&
      typeof (msg as RpcRequest).method === "string"
    );
  }

  dispose(): void {
    for (const ac of this.inFlight.values()) {
      ac.abort();
    }
    this.inFlight.clear();
  }
}
