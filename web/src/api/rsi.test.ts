import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ForgePilotClient } from "./client";
import type { JsonFetch, RsiProposalList, RsiStatus } from "./client";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/rsi-api-v1",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: JsonFetch & Mock): ForgePilotClient {
  return new ForgePilotClient({
    baseUrl: "http://127.0.0.1:4567",
    token: "local-secret",
    fetchImpl,
  });
}

describe("RSI API client", () => {
  it("lists proposals with the status, risk, and limit filters", async () => {
    const page = fixture<RsiProposalList>("proposals.json");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(page));
    const client = clientWith(fetchImpl);

    const proposals = await client.listRsiProposals("wsp_rsi", {
      status: "canary",
      risk: "A",
      limit: 25,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4567/api/v1/workspaces/wsp_rsi/memory/proposals?status=canary&risk=A&limit=25",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer local-secret" }),
      }),
    );
    expect(proposals[0]?.proposal_id).toBe(page.proposals[0]?.proposal_id);
  });

  it("reads proposal detail and workspace status from the contract paths", async () => {
    const proposal = fixture<unknown>("proposal-canary.json");
    const status = fixture<RsiStatus>("status.json");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(proposal))
      .mockResolvedValueOnce(jsonResponse(status));
    const client = clientWith(fetchImpl);

    await client.getRsiProposal("wsp_rsi", "rsi/1");
    await client.getRsiStatus("wsp_rsi");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/wsp_rsi/memory/proposals/rsi%2F1",
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/wsp_rsi/memory/rsi/status",
    );
  });

  it("sends only dataset selection to the server-run replay", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(fixture<unknown>("proposal-ready.json")));
    const client = clientWith(fetchImpl);

    await client.evaluateRsiProposal("wsp_rsi", "rsi_1", ["golden", "holdout"]);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ datasets: ["golden", "holdout"] });
  });

  it("records approval, canary, observation, and rollback calls", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(fixture<unknown>("proposal-canary.json"))),
      );
    const client = clientWith(fetchImpl);

    await client.approveRsiProposal("wsp_rsi", "rsi_1", "reviewed replay");
    await client.startRsiCanary("wsp_rsi", "rsi_1");
    await client.recordRsiCanaryObservation("wsp_rsi", "rsi_1");
    await client.rollbackRsiProposal("wsp_rsi", "rsi_1", "security review");

    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/proposals\/rsi_1\/approvals$/);
    expect(JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      note: "reviewed replay",
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toMatch(/\/proposals\/rsi_1\/canary$/);
    expect(fetchImpl.mock.calls[2]?.[0]).toMatch(/\/proposals\/rsi_1\/canary\/observations$/);
    expect(JSON.parse(String((fetchImpl.mock.calls[3]?.[1] as RequestInit).body))).toEqual({
      reason: "security review",
    });
  });

  it("engages the kill switch and returns the updated controls", async () => {
    const response = fixture<{ controls: { kill_switch: boolean } }>("kill-switch-engaged.json");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(response));
    const client = clientWith(fetchImpl);

    const controls = await client.setRsiKillSwitch("wsp_rsi", true, "security incident");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/wsp_rsi/memory/rsi/kill-switch",
    );
    expect(JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      enabled: true,
      reason: "security incident",
    });
    expect(controls.kill_switch).toBe(true);
  });

  it("patches only the tightened controls", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fixture<unknown>("controls.json")));
    const client = clientWith(fetchImpl);

    await client.updateRsiControls("wsp_rsi", {
      auto_promote_low_risk: false,
      weekly_change_budget: 2,
    });

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      auto_promote_low_risk: false,
      weekly_change_budget: 2,
    });
  });
});
