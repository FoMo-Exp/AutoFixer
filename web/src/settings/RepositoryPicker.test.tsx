// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";

import { RepositoryPicker } from "./RepositoryPicker";

const ACCOUNT = {
  id: "acct_aaaaaaaaaaaaaaaa",
  provider: "github" as const,
  instanceUrl: "https://github.com",
  login: "Luthiel",
  createdAt: "2026-01-01T00:00:00.000Z",
};

// The real shape seen in the field: the form default points at one owner
// (github:Luthiel/AutoFixer) while the bound account discovers the repo under
// another (github:FoMo-Exp/AutoFixer).
const REPO = {
  id: "github:FoMo-Exp/AutoFixer",
  provider: "github" as const,
  owner: "FoMo-Exp",
  name: "AutoFixer",
  defaultBranch: "main" as string | null,
  private: false,
};

/** Stateful harness mirroring how App drives the controlled picker. */
function Harness({ initialRepo, initialRef }: { initialRepo: string; initialRef: string }) {
  const [repositoryId, setRepositoryId] = useState(initialRepo);
  const [baseRef, setBaseRef] = useState(initialRef);
  return (
    <RepositoryPicker
      repositoryId={repositoryId}
      baseRef={baseRef}
      onChange={(patch) => {
        if (patch.repositoryId !== undefined) setRepositoryId(patch.repositoryId);
        if (patch.baseRef !== undefined) setBaseRef(patch.baseRef);
      }}
      onOpenSettings={() => undefined}
    />
  );
}

function mockBridge(repo: typeof REPO, branches: Array<{ name: string; isDefault: boolean }>) {
  window.forgePilotSettings = {
    listAccounts: async () => [ACCOUNT],
    saveAccount: async () => ACCOUNT,
    removeAccount: async () => undefined,
    listRepositories: async () => [repo],
    listBranches: async () => branches,
  };
}

const BRANCHES_MAIN_DEV = [
  { name: "main", isDefault: true },
  { name: "dev", isDefault: false },
];

function baseRefSelect(): HTMLSelectElement {
  const [, ref] = screen.getAllByRole("combobox") as HTMLSelectElement[];
  return ref;
}

function optionLabels(select: HTMLSelectElement): string {
  return Array.from(select.options)
    .map((option) => option.textContent ?? "")
    .join(" ");
}

afterEach(() => {
  cleanup();
  delete (window as { forgePilotSettings?: unknown }).forgePilotSettings;
});

describe("auto-prefill when the default repository is not discovered", () => {
  it("auto-selects the discovered repo by name and offers its branches", async () => {
    mockBridge({ ...REPO, defaultBranch: "main" }, BRANCHES_MAIN_DEV);
    // The default points at an owner the account does not see; the discovered
    // AutoFixer should be recognised by name and auto-selected.
    render(<Harness initialRepo="github:Luthiel/AutoFixer" initialRef="main" />);

    // REGRESSION (field bug): the create dialog opened with both fields as
    // free-text inputs because the default matched nothing, so base ref never
    // offered branches. After auto-prefill both must be selects.
    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBe(2);
    });
    const [repoSelect, refSelect] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(repoSelect.value).toContain(REPO.id);
    expect(optionLabels(refSelect)).toContain("main");
    expect(optionLabels(refSelect)).toContain("dev");
  });

  it("leaves an already-discovered default untouched", async () => {
    mockBridge({ ...REPO, defaultBranch: "main" }, BRANCHES_MAIN_DEV);
    // Start already on the discovered repo: auto-prefill must not rewrite it.
    render(<Harness initialRepo={REPO.id} initialRef="main" />);

    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBe(2);
    });
    const [repoSelect] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(repoSelect.value).toContain(REPO.id);
  });
});

describe("base-ref select across default-branch scenarios", () => {
  it("offers the branches when the default branch is known", async () => {
    mockBridge({ ...REPO, defaultBranch: "main" }, BRANCHES_MAIN_DEV);
    render(<Harness initialRepo={REPO.id} initialRef="main" />);

    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBe(2);
    });
    const labels = optionLabels(baseRefSelect());
    expect(labels).toContain("main");
    expect(labels).toContain("dev");
  });

  it("offers the branches even when the repo has no known default branch", async () => {
    mockBridge({ ...REPO, defaultBranch: null }, [
      { name: "main", isDefault: false },
      { name: "dev", isDefault: false },
    ]);
    render(<Harness initialRepo={REPO.id} initialRef="main" />);

    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBe(2);
    });
    const labels = optionLabels(baseRefSelect());
    expect(labels).toContain("main");
    expect(labels).toContain("dev");
  });

  it("offers the branches even when the inherited base ref is not among them", async () => {
    mockBridge({ ...REPO, defaultBranch: null }, [
      { name: "dev", isDefault: false },
      { name: "release", isDefault: false },
    ]);
    // baseRef is a stale ref that the new repo's branches do not contain; the
    // field must still surface them (landing on "Custom ref…") rather than
    // trapping the user in a text box.
    render(<Harness initialRepo={REPO.id} initialRef="staging" />);

    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBe(2);
    });
    const labels = optionLabels(baseRefSelect());
    expect(labels).toContain("dev");
    expect(labels).toContain("release");
  });
});

describe("Custom (free-text) mode keeps the typed value and offers a way back", () => {
  it("stays free text while typing a discovered id, preserving the value", async () => {
    mockBridge({ ...REPO, defaultBranch: "main" }, BRANCHES_MAIN_DEV);
    render(<Harness initialRepo={REPO.id} initialRef="main" />);

    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBe(2);
    });
    const [repoSelect] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    await userEvent.selectOptions(repoSelect, "__forgepilot_custom_repository__");

    // In Custom/input view the field stays free text even when the typed id
    // matches a discovered repo — the input must not jump away mid-typing.
    const repoInput = await screen.findByPlaceholderText("github:owner/repo");
    await userEvent.clear(repoInput);
    await userEvent.type(repoInput, REPO.id);
    expect((repoInput as HTMLInputElement).value).toBe(REPO.id);
    expect(screen.queryByRole("combobox")).not.toBeNull(); // base-ref select still present
    // The repository field is the only free-text control now.
    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes.length).toBe(1);
  });

  it("offers 'Choose from discovered…' to return to the select", async () => {
    mockBridge({ ...REPO, defaultBranch: "main" }, BRANCHES_MAIN_DEV);
    render(<Harness initialRepo={REPO.id} initialRef="main" />);

    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBe(2);
    });
    const [repoSelect] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    await userEvent.selectOptions(repoSelect, "__forgepilot_custom_repository__");

    // The way back to the select is an explicit click, not typing.
    const backButton = await screen.findByText(/choose from discovered/i);
    await userEvent.click(backButton);
    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBe(2);
    });
  });
});
