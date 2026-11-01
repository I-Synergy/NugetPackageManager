import type { HostAPI, RpcRequest, RpcResponse, RpcCancel } from "./types";
import type { Result } from "./result";
import { fail } from "./result";

type PendingCall = {
  resolve: (result: Result<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: (() => void) | undefined;
};

export function createRpcClient(
  postMessage: (msg: unknown) => void,
  timeoutMs: number = 30_000
): HostAPI {
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

  window.addEventListener("message", (event: MessageEvent) => {
    // Only accept messages from this webview's own origin. Messages relayed from
    // another window (or a host that cannot prove its origin) are ignored.
    if (event.origin !== window.location.origin) return;

    const msg = event.data as RpcResponse;
    if (msg?.type !== "rpc-response") return;

    const call = pending.get(msg.id);
    if (!call) return;

    clearTimeout(call.timer);
    call.cleanup?.();
    pending.delete(msg.id);
    call.resolve(msg.result);
  });

  function call(method: string, params: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    return new Promise<Result<unknown>>((resolve) => {
      if (signal?.aborted) {
        resolve(fail("cancelled"));
        return;
      }

      const id = nextId++;

      const cancel = (): void => {
        const c = pending.get(id);
        if (!c) return;
        clearTimeout(c.timer);
        pending.delete(id);
        postMessage({ type: "rpc-cancel", id } satisfies RpcCancel);
        resolve(fail("cancelled"));
      };

      const cleanup = signal ? (): void => { signal.removeEventListener("abort", cancel); } : undefined;

      signal?.addEventListener("abort", cancel, { once: true });

      const timer = setTimeout(() => {
        // A client deadline is not a cancellation. Cancelling here would abort
        // host work that is merely slow (restore on a large repo), and the
        // transactional paths treat an abort as a failure and roll back files
        // that were already written successfully. Drop the pending call so the
        // late response is ignored, but let the host finish the operation.
        pending.delete(id);
        cleanup?.();
        resolve(fail(
          `RPC timeout after ${timeoutMs}ms for method: ${method} (the operation is still running in the extension host)`
        ));
      }, timeoutMs);

      pending.set(id, { resolve, timer, cleanup });

      const request: RpcRequest = {
        type: "rpc-request",
        id,
        method,
        params,
      };
      postMessage(request);
    });
  }

  return new Proxy({} as HostAPI, {
    get(_target, prop: string) {
      return (params: unknown, signal?: AbortSignal) => call(prop, params, signal);
    },
  });
}
