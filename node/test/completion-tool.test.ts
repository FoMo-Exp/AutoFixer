import { describe, expect, test } from "vitest";

import {
  COMPLETE_PREPARATION_TOOL_NAME,
  createCompletePreparationTool,
} from "../src/pi/completion-tool.js";
import type { PreparationCompletion } from "../src/pi/completion-tool.js";

function completion(overrides: Partial<PreparationCompletion> = {}): PreparationCompletion {
  return { state: "stopped", stopped: true, prepared: true, ...overrides };
}

describe("complete_local_preparation tool (DAT-258)", () => {
  test("asks the orchestrator to complete and reports the frozen candidate", async () => {
    const calls: number[] = [];
    const tool = createCompletePreparationTool({
      complete: async () => {
        calls.push(1);
        return completion();
      },
    });
    const result = await tool.execute("call_1", {});
    expect(calls).toHaveLength(1);
    expect(tool.name).toBe(COMPLETE_PREPARATION_TOOL_NAME);
    expect(result.details).toEqual({ state: "stopped", stopped: true, prepared: true });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("frozen as a candidate");
  });

  test("a stop without a frozen revision is reported as no candidate, never as success", async () => {
    const tool = createCompletePreparationTool({
      complete: async () => completion({ prepared: false }),
    });
    const result = await tool.execute("call_2", {});
    expect(result.details).toEqual({ state: "stopped", stopped: true, prepared: false });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("without a reviewable candidate");
    expect(text).not.toContain("frozen as a candidate");
  });

  test("a refused completion rejects the tool call instead of reporting completion", async () => {
    const tool = createCompletePreparationTool({
      complete: async () => {
        throw new Error("DSH_RUN_BUSY: A tool execution is still in flight for this run.");
      },
    });
    await expect(tool.execute("call_3", {})).rejects.toThrow(/DSH_RUN_BUSY/);
  });

  test("the tool takes no parameters: completion is not argument-shaped", () => {
    const tool = createCompletePreparationTool({
      complete: async () => completion(),
    });
    expect(tool.parameters).toMatchObject({ type: "object", properties: {} });
  });
});
