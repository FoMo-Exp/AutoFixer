// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskTargetList } from "../api/client";
import { TaskTargetField } from "./TaskTargetField";
import {
  INITIAL_TARGET_VIEW,
  taskTargetCreateReady,
  taskTargetInput,
  targetBlockedMessage,
} from "./task-target";
import type { TaskTargetView } from "./task-target";

const TRUSTED = {
  binding_id: "wrb_alpha",
  repository_id: "github:FoMo-Exp/AutoFixer",
  provider_instance_id: "pi_github",
  installation_ref: "svi_1",
  repository_name: "FoMo-Exp/AutoFixer",
  position: 1,
  baseline: {
    state: "trusted" as const,
    base_ref: "main",
    base_sha: "52081eaddca099967fd8be13b3060337fde50d3f",
  },
};

const UNPINNED = {
  binding_id: "wrb_beta",
  repository_id: "github:FoMo-Exp/Docs",
  provider_instance_id: "pi_github",
  installation_ref: "svi_1",
  repository_name: "FoMo-Exp/Docs",
  position: 2,
  baseline: {
    state: "unavailable" as const,
    base_ref: null,
    base_sha: null,
    reason: "baseline_not_pinned" as const,
  },
};

function list(overrides: Partial<TaskTargetList> = {}): TaskTargetList {
  return {
    workspace_id: "wsp_1",
    repository_set_version: 4,
    multi_repository: true,
    selection_required: true,
    usable: true,
    blocked_reason: null,
    targets: [TRUSTED, UNPINNED],
    ...overrides,
  };
}

function ready(overrides: Partial<TaskTargetList> = {}): TaskTargetView {
  return { status: "ready", list: list(overrides) };
}

function Harness({ view, retry = () => undefined }: { view: TaskTargetView; retry?: () => void }) {
  const [bindingId, setBindingId] = useState("");
  return (
    <TaskTargetField
      view={view}
      selectedBindingId={bindingId}
      onSelect={setBindingId}
      onRetry={retry}
    />
  );
}

afterEach(cleanup);

describe("multi-repository target selection", () => {
  it("requires an explicit choice and disables a target without a trusted baseline", async () => {
    render(<Harness view={ready()} />);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(
      (screen.getByRole("radio", { name: /FoMo-Exp\/Docs/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getByText("No trusted baseline")).toBeTruthy();
    expect(taskTargetCreateReady(ready(), "")).toBe(false);

    await userEvent.click(screen.getByRole("radio", { name: /FoMo-Exp\/AutoFixer/ }));
    expect((screen.getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(true);
    expect(taskTargetCreateReady(ready(), TRUSTED.binding_id)).toBe(true);
  });

  it("selects with the keyboard and sends the observed set version", async () => {
    render(<Harness view={ready()} />);
    const radio = screen.getByRole("radio", { name: /FoMo-Exp\/AutoFixer/ });
    radio.focus();
    await userEvent.keyboard(" ");
    expect((radio as HTMLInputElement).checked).toBe(true);
    expect(taskTargetInput(ready(), TRUSTED.binding_id)).toEqual({
      target: {
        repository_id: TRUSTED.repository_id,
        provider_instance_id: TRUSTED.provider_instance_id,
        installation_ref: TRUSTED.installation_ref,
        base_ref: "main",
        expected_set_version: 4,
      },
    });
  });

  it("describes a closed rollout gate and keeps every choice disabled", () => {
    render(
      <Harness
        view={ready({
          usable: false,
          blocked_reason: "MULTI_REPOSITORY_SCOPE_DISABLED",
        })}
      />,
    );
    expect(screen.getByText(targetBlockedMessage("MULTI_REPOSITORY_SCOPE_DISABLED"))).toBeTruthy();
    expect(
      screen.getAllByRole("radio").every((radio) => (radio as HTMLInputElement).disabled),
    ).toBe(true);
    expect(taskTargetCreateReady(ready({ usable: false }), TRUSTED.binding_id)).toBe(false);
  });

  it("shows a conflict and an empty set without offering a fallback", () => {
    render(
      <TaskTargetField
        view={{ status: "ready", list: list({ targets: [] }) }}
        selectedBindingId=""
        conflict="The repository set changed. Select the target again."
        onSelect={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Select the target again");
    expect(screen.getByText("No selectable repository target.")).toBeTruthy();
    expect(taskTargetCreateReady(ready({ targets: [] }), "")).toBe(false);
  });
});

describe("single-repository compatibility", () => {
  const single = ready({
    multi_repository: false,
    selection_required: false,
    targets: [TRUSTED],
  });

  it("renders the trusted binding read-only and submits the legacy selectors", () => {
    render(<Harness view={single} />);
    const repository = screen.getByLabelText("Repository") as HTMLInputElement;
    const baseRef = screen.getByLabelText("Base ref") as HTMLInputElement;
    expect(repository.value).toBe("FoMo-Exp/AutoFixer");
    expect(repository.readOnly).toBe(true);
    expect(baseRef.value).toBe("main");
    expect(baseRef.readOnly).toBe(true);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(taskTargetCreateReady(single, "")).toBe(true);
    expect(taskTargetInput(single, "")).toEqual({
      repository_id: TRUSTED.repository_id,
      base_ref: "main",
    });
  });
});

describe("unavailable target reads", () => {
  it("keeps creation closed while loading and while a read failed", async () => {
    expect(taskTargetCreateReady(INITIAL_TARGET_VIEW, "")).toBe(false);
    const retry = vi.fn();
    const { rerender } = render(
      <Harness
        view={{ status: "error", error: "FORBIDDEN: no repository authority" }}
        retry={retry}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("FORBIDDEN");
    await userEvent.click(screen.getByRole("button", { name: "Retry loading repository targets" }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<Harness view={{ status: "ready", list: list({ targets: [] }) }} retry={retry} />);
    expect(taskTargetCreateReady({ status: "ready", list: list({ targets: [] }) }, "")).toBe(false);
  });
});
