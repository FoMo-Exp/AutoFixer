import { describe, expect, it } from "vitest";
import { createStaticServiceCredentialStore } from "../src/provider-access/credentials.js";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
} from "../src/provider-access/provider-http.js";
import { createProviderIssueApi } from "../src/issue-sync/provider-api.js";

function response(body: unknown, status = 200): ProviderHttpResponse {
  return { status, headers: {}, body: JSON.stringify(body) };
}

describe("provider issue API", () => {
  it("creates GitHub issues with the dedicated credential and correct repo path", async () => {
    const requests: ProviderHttpRequest[] = [];
    const api = createProviderIssueApi({
      repository_id: "github:FoMo-Exp/AutoFixer",
      issue_sync_credential_ref: "issues-token",
      credentials: createStaticServiceCredentialStore({ "issues-token": "secret-value" }),
      api_base_url: "https://api.github.test",
      http: async (request) => {
        requests.push(request);
        return response(
          {
            id: 91,
            number: 42,
            html_url: "https://github.test/FoMo-Exp/AutoFixer/issues/42",
            title: "A bug",
            body: "Details",
            state: "open",
            labels: [{ name: "bug" }],
            updated_at: "2026-11-14T10:00:00Z",
          },
          201,
        );
      },
    });

    const created = await api.createIssue({
      title: "A bug",
      description: "Details",
      labels: ["bug"],
    });

    expect(created.number).toBe("42");
    expect(created.description).toBe("Details");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("https://api.github.test/repos/FoMo-Exp/AutoFixer/issues");
    expect(requests[0]?.headers.Authorization).toBe("Bearer secret-value");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      title: "A bug",
      body: "Details",
      labels: ["bug"],
    });
  });

  it("maps GitLab labels and close/reopen state through its issue API", async () => {
    const requests: ProviderHttpRequest[] = [];
    const api = createProviderIssueApi({
      repository_id: "gitlab:group/subgroup/AutoFixer",
      issue_sync_credential_ref: "issues-token",
      credentials: createStaticServiceCredentialStore({ "issues-token": "secret-value" }),
      api_base_url: "https://gitlab.test/api/v4",
      http: async (request) => {
        requests.push(request);
        return response({
          id: 901,
          iid: 12,
          web_url: "https://gitlab.test/group/subgroup/AutoFixer/-/issues/12",
          title: "A bug",
          description: "Details",
          state: "closed",
          labels: ["bug", "urgent"],
          updated_at: "2026-11-14T10:00:00Z",
        });
      },
    });

    const updated = await api.updateIssue("12", { state: "closed", labels: ["bug", "urgent"] });

    expect(updated.state).toBe("closed");
    expect(requests[0]?.url).toBe(
      "https://gitlab.test/api/v4/projects/group%2Fsubgroup%2FAutoFixer/issues/12",
    );
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      labels: "bug,urgent",
      state_event: "close",
    });
  });
});
