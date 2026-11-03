/** Stable error contract for intake-layer control failures. */
export class IntakeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "IntakeError";
  }
}
