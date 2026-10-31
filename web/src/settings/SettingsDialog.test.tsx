// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import type { ModelConnectionResult } from "./client";

const snapshot = {
  providers: [
    // A running main process may still return the old provider snapshot.
    { id: "openai", label: "OpenAI" },
    { id: "anthropic", label: "Anthropic" },
    { id: "openai-compatible", label: "OpenAI-compatible" },
  ],
  current: { provider: "openai", modelId: "saved-model", apiKeyConfigured: true },
  secureStorageAvailable: true,
};
const probe = vi.fn<(input: unknown) => Promise<ModelConnectionResult>>();
const save = vi.fn(async () => snapshot);
beforeEach(() => {
  probe.mockReset().mockResolvedValue({
    ok: true,
    message: "Connection successful. 2 models available.",
    latencyMs: 124,
    models: ["model-a", "model-b"],
  });
  save.mockClear();
  window.forgePilotSettings = {
    getModelSettings: async () => snapshot,
    saveModelSettings: save,
    removeModelSettings: async () => undefined,
    testModelConnection: probe,
    listAccounts: async () => [],
    saveAccount: vi.fn(),
    removeAccount: async () => undefined,
    listRepositories: async () => [],
    listBranches: async () => [],
  };
});
afterEach(() => {
  cleanup();
  delete window.forgePilotSettings;
});

async function switchProvider(name: string) {
  await userEvent.click(screen.getByRole("combobox", { name: "Provider" }));
  await userEvent.click(screen.getByRole("option", { name }));
}

describe("model discovery settings", () => {
  it("uses built-in providers and URLs even when the main process returns an older catalogue", async () => {
    render(<SettingsDialog onClose={() => undefined} />);
    await screen.findByDisplayValue("saved-model");
    expect((screen.getByLabelText("API base URL") as HTMLInputElement).value).toBe(
      "https://api.openai.com/v1",
    );
    await switchProvider("Xiaomi MiMo");
    expect((screen.getByLabelText("API base URL") as HTMLInputElement).value).toBe(
      "https://api.xiaomimimo.com/anthropic",
    );
    await switchProvider("Anthropic");
    expect((screen.getByLabelText("API base URL") as HTMLInputElement).value).toBe(
      "https://api.anthropic.com",
    );
  });

  it("prefills the initial provider URL without any saved configuration", async () => {
    window.forgePilotSettings!.getModelSettings = async () => ({
      providers: [],
      secureStorageAvailable: true,
    });
    render(<SettingsDialog onClose={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Provider" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(screen.getByRole("combobox", { name: "Provider" }).textContent).toBe("Anthropic");
    expect((screen.getByLabelText("API base URL") as HTMLInputElement).value).toBe(
      "https://api.anthropic.com",
    );
  });

  it("preserves a saved custom URL until the provider changes", async () => {
    window.forgePilotSettings!.getModelSettings = async () => ({
      ...snapshot,
      current: { ...snapshot.current, baseUrl: "https://custom.example/v1" },
    });
    render(<SettingsDialog onClose={() => undefined} />);
    await screen.findByDisplayValue("saved-model");
    expect((screen.getByLabelText("API base URL") as HTMLInputElement).value).toBe(
      "https://custom.example/v1",
    );
    await switchProvider("Xiaomi MiMo");
    await switchProvider("OpenAI");
    expect((screen.getByLabelText("API base URL") as HTMLInputElement).value).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("loads models without a Model ID, switches to the shared select and saves the choice", async () => {
    render(<SettingsDialog onClose={() => undefined} />);
    const initialModel = await screen.findByDisplayValue("saved-model");
    await userEvent.clear(initialModel);
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Connection successful.*124 ms/)).toBeTruthy();
    expect(probe).toHaveBeenCalledWith({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(save).not.toHaveBeenCalled();
    const select = screen.getByRole("combobox", { name: "Model ID" });
    expect(select.classList.contains("custom-select-trigger")).toBe(true);
    expect(select.textContent).toBe("model-a");
    await userEvent.click(select);
    await userEvent.click(screen.getByRole("option", { name: "model-b" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    expect(save).toHaveBeenCalledWith({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      modelId: "model-b",
    });
  });

  it("preserves a selected model still available in the fetched list", async () => {
    probe.mockResolvedValue({
      ok: true,
      message: "Models loaded",
      models: ["model-a", "saved-model"],
    });
    render(<SettingsDialog onClose={() => undefined} />);
    await screen.findByDisplayValue("saved-model");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("combobox", { name: "Model ID" })).textContent).toBe(
      "saved-model",
    );
  });

  it("orders the fields Provider / URL / Key / Model ID", async () => {
    render(<SettingsDialog onClose={() => undefined} />);
    await screen.findByDisplayValue("saved-model");
    const fields = document.querySelectorAll(".model-settings-fields .picker-field > label");
    expect(Array.from(fields, (field) => field.textContent?.replace("*", "").trim())).toEqual([
      "Provider",
      "API base URL",
      "API key",
      "Model ID",
    ]);
  });

  it("prefills Xiaomi's endpoint and clears the key, model and catalogue when switching provider", async () => {
    render(<SettingsDialog onClose={() => undefined} />);
    await screen.findByDisplayValue("saved-model");
    await userEvent.type(screen.getByLabelText(/API key/), "previous-provider-key");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("combobox", { name: "Model ID" });
    await switchProvider("Xiaomi MiMo");
    expect((screen.getByLabelText("API base URL") as HTMLInputElement).value).toBe(
      "https://api.xiaomimimo.com/anthropic",
    );
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Model ID") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("combobox", { name: "Model ID" })).toBeNull();
    expect(screen.queryByText(/Connection successful/)).toBeNull();
  });

  it("leaves the compatible endpoint blank and enables discovery after it is entered", async () => {
    render(<SettingsDialog onClose={() => undefined} />);
    await screen.findByDisplayValue("saved-model");
    await switchProvider("OpenAI-compatible");
    const url = screen.getByLabelText("API base URL");
    expect((url as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Test connection" }).hasAttribute("disabled")).toBe(
      true,
    );
    await userEvent.type(url, "http://localhost:1234/v1");
    expect(screen.getByRole("button", { name: "Test connection" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect((screen.getByLabelText("Model ID") as HTMLInputElement).value).toBe("");
  });

  it.each(["API base URL", "API key"])(
    "invalidates the model list after editing %s",
    async (field) => {
      render(<SettingsDialog onClose={() => undefined} />);
      await screen.findByDisplayValue("saved-model");
      await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
      await screen.findByRole("combobox", { name: "Model ID" });
      await userEvent.type(screen.getByLabelText(new RegExp(field)), "changed");
      expect(screen.queryByRole("combobox", { name: "Model ID" })).toBeNull();
      expect(screen.queryByText(/Connection successful/)).toBeNull();
    },
  );

  it("locks fields while loading and keeps manual input available on failure", async () => {
    let settle!: (result: ModelConnectionResult) => void;
    probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    render(<SettingsDialog onClose={() => undefined} />);
    const model = await screen.findByDisplayValue("saved-model");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(screen.getByRole("button", { name: "Testing…" }).hasAttribute("disabled")).toBe(true);
    expect(model.hasAttribute("disabled")).toBe(true);
    settle({ ok: false, message: "Authentication failed. Check the API key." });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Authentication failed. Check the API key.",
    );
    await waitFor(() => expect(model.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByRole("combobox", { name: "Model ID" })).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
