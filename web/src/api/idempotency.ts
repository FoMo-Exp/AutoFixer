export class CreateIdempotencyKeys {
  private readonly keys = new Map<string, string>();

  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

  forInput(input: unknown): string {
    const fingerprint = JSON.stringify(input);
    const existing = this.keys.get(fingerprint);
    if (existing) return existing;
    const key = `forgepilot-ui-${this.createId()}`;
    this.keys.set(fingerprint, key);
    return key;
  }

  complete(input: unknown): void {
    this.keys.delete(JSON.stringify(input));
  }
}
