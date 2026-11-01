import type { DotnetFailure } from "./dotnet-failure";

/** A failed `dotnet` invocation, carrying the classified cause when one was found. */
export class DotnetError extends Error {
  constructor(
    message: string,
    public readonly output: string,
    public readonly failure?: DotnetFailure
  ) {
    super(message);
    this.name = "DotnetError";
  }
}
