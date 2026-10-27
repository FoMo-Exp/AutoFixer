import { describe, expect, it, vi } from "vitest";
import { CreateIdempotencyKeys } from "./idempotency";

describe("create request idempotency keys", () => {
  it("reuses the key for the same payload until success clears it", () => {
    const createId = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");
    const keys = new CreateIdempotencyKeys(createId);
    const payload = { summary: "same request" };

    expect(keys.forInput(payload)).toBe("forgepilot-ui-first");
    expect(keys.forInput(payload)).toBe("forgepilot-ui-first");
    keys.complete(payload);
    expect(keys.forInput(payload)).toBe("forgepilot-ui-second");
    expect(createId).toHaveBeenCalledTimes(2);
  });

  it("does not share keys between distinct payloads", () => {
    const keys = new CreateIdempotencyKeys(
      vi.fn().mockReturnValueOnce("one").mockReturnValueOnce("two"),
    );
    expect(keys.forInput({ summary: "first" })).not.toBe(keys.forInput({ summary: "second" }));
  });
});
