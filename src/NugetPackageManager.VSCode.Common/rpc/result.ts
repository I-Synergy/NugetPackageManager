export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = void>(error: string): Result<T> => ({ ok: false, error });

/**
 * The single text a cancelled host request reports.
 *
 * A webview that re-renders can drop an in-flight RPC, which the host answers with this message.
 * Views compare against it instead of matching the string themselves.
 */
export const CANCELLED_ERROR = "The request was cancelled.";

export function isCancelledMessage(message: string): boolean {
  return message === CANCELLED_ERROR;
}
