import { CoreError } from "../nuget/core-error";

/**
 * True when an error means "the caller went away", not "something failed".
 *
 * `RpcHost` aborts a handler's `AbortController` when the webview sends `rpc-cancel` - a view
 * re-render, a tab closing, an `@lit/task` re-run. The handler's `signal` then aborts and the
 * shared work behind it (the workspace parse, the outdated scan) keeps running for everybody
 * else. Logging that at ERROR claims a failure that did not happen, and the message the user
 * sees ("Failed to check for outdated packages: This operation was aborted") is misleading.
 *
 * Two shapes reach a handler's `catch`:
 * - a DOM `AbortError` (`DOMException`), which is what `signal.reason` is by default, and
 * - a `CoreError` with code `cancelled`, when the .NET core reports that it stopped because the
 *   request was cancelled.
 */
export function isCancellation(error: unknown): boolean {
  if (error instanceof CoreError && error.code === "cancelled") return true;
  // `DOMException` is not an `Error` in every runtime, so this reads `name` structurally.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
