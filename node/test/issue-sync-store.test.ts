import { afterEach, describe, expect, it } from "vitest";
import { openControlPlaneDb } from "../src/control-plane/db.js";
import type { ControlPlaneDb } from "../src/control-plane/db.js";
import { IssueSyncConflict, IssueSyncStore } from "../src/issue-sync/store.js";
import { createIssueVersionHistory } from "../src/issue-sync/versions.js";

let db: ControlPlaneDb | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function setup(): IssueSyncStore {
  db = openControlPlaneDb();
  const now = "2026-11-14T10:00:00.000Z";
  db.prepare(
    `INSERT INTO enterprise (id, name, slug, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("ent_1", "Example", "example", now, now, "usr_1", "usr_1");
  db.prepare(
    `INSERT INTO provider_instance
       (id, enterprise_id, provider_type, origin_url, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("pi_1", "ent_1", "github", "https://github.com", now, now, "usr_1", "usr_1");
  db.prepare(
    `INSERT INTO workspace
       (id, enterprise_id, name, repository_id, provider_instance_id, status,
        created_at, updated_at, created_by, updated_by, version)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1)`,
  ).run(
    "ws_1",
    "ent_1",
    "Example",
    "github:owner/repo",
    "pi_1",
    now,
    now,
    "usr_1",
    "usr_1",
  );
  return new IssueSyncStore(db);
}

describe("durable issue sync store", () => {
  it("links one provider issue and persists immutable versions/comments", () => {
    const store = setup();
    const link = store.linkIssue({
      enterprise_id: "ent_1",
      workspace_id: "ws_1",
      issue_id: "iss_1",
      provider_instance_id: "pi_1",
      provider_type: "github",
      repository_id: "github:owner/repo",
      provider_issue_id: "9001",
      provider_issue_number: "42",
      provider_url: "https://github.com/owner/repo/issues/42",
      provider_state: "open",
      provider_updated_at: "2026-11-14T10:00:00Z",
      last_synced_at: "2026-11-14T10:00:00Z",
    });
    const history = createIssueVersionHistory(
      "iss_1",
      { title: "Bug", description: "Details", state: "open", labels: ["bug"] },
      "github",
      "2026-11-14T10:00:00Z",
      "2026-11-14T10:00:00Z",
    );
    store.appendVersion("ws_1", "iss_1", history.versions[0]!);
    store.appendComments("ws_1", "iss_1", [
      {
        id: "comment_1",
        source: "github",
        source_comment_id: "55",
        author: "alice",
        body: "Repro steps attached",
        created_at: "2026-11-14T10:01:00Z",
      },
    ]);

    expect(store.getLinkByIssue("ws_1", "iss_1")).toMatchObject(link);
    expect(store.getLinkByProvider("pi_1", "github:owner/repo", "9001")).toMatchObject(link);
    expect(store.listVersions("ws_1", "iss_1")).toEqual(history.versions);
    expect(store.listComments("ws_1", "iss_1")).toHaveLength(1);
  });

  it("deduplicates webhook deliveries and outbox retries by stable key", () => {
    const store = setup();
    const first = store.enqueue({
      enterprise_id: "ent_1",
      workspace_id: "ws_1",
      issue_id: "iss_1",
      idempotency_key: "create-iss-1",
      operation_type: "create",
      payload: { title: "Bug" },
    });

    const replay = store.enqueue({
      enterprise_id: "ent_1",
      workspace_id: "ws_1",
      issue_id: "iss_1",
      idempotency_key: "create-iss-1",
      operation_type: "create",
      payload: { title: "Bug" },
    });
    expect(replay.operation_id).toBe(first.operation_id);
    expect(store.receiveWebhook("pi_1", "delivery_1", "ws_1")).toBe(true);
    expect(store.receiveWebhook("pi_1", "delivery_1", "ws_1")).toBe(false);
  });

  it("rejects idempotency-key reuse with a different operation", () => {
    const store = setup();
    store.enqueue({
      enterprise_id: "ent_1",
      workspace_id: "ws_1",
      issue_id: "iss_1",
      idempotency_key: "same-key",
      operation_type: "update",
      payload: { title: "first" },
    });
    expect(() =>
      store.enqueue({
        enterprise_id: "ent_1",
        workspace_id: "ws_1",
        issue_id: "iss_1",
        idempotency_key: "same-key",
        operation_type: "update",
        payload: { title: "second" },
      }),
    ).toThrow(IssueSyncConflict);
  });
});
