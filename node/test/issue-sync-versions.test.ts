import { describe, expect, it } from "vitest";
import {
  applyIssueChange,
  createIssueVersionHistory,
  rollbackIssueContent,
  type SyncedIssueContent,
} from "../src/issue-sync/versions.js";

const initial: SyncedIssueContent = {
  title: "Original title",
  description: "Original description",
  state: "open",
  labels: ["bug"],
};

function history() {
  return createIssueVersionHistory(
    "iss_1",
    initial,
    "forgepilot",
    "2026-11-14T09:00:00Z",
    "2026-11-14T09:00:00Z",
  );
}

describe("provider issue versions", () => {
  it("merges updates to independent fields", () => {
    const first = applyIssueChange(history(), {
      source: "github",
      source_modified_at: "2026-11-14T09:02:00Z",
      recorded_at: "2026-11-14T09:02:01Z",
      fields: { description: "Updated remotely" },
    });
    const merged = applyIssueChange(first, {
      source: "forgepilot",
      source_modified_at: "2026-11-14T09:03:00Z",
      recorded_at: "2026-11-14T09:03:00Z",
      fields: { title: "Updated locally" },
    });

    expect(merged.content).toEqual({
      title: "Updated locally",
      description: "Updated remotely",
      state: "open",
      labels: ["bug"],
    });
    expect(merged.versions).toHaveLength(3);
  });

  it("uses the later source timestamp for competing field changes", () => {
    const remote = applyIssueChange(history(), {
      source: "github",
      source_modified_at: "2026-11-14T09:02:00Z",
      recorded_at: "2026-11-14T09:02:01Z",
      fields: { title: "Remote title" },
    });
    const stale = applyIssueChange(remote, {
      source: "forgepilot",
      source_modified_at: "2026-11-14T09:01:00Z",
      recorded_at: "2026-11-14T09:03:00Z",
      fields: { title: "Stale local title" },
    });
    const later = applyIssueChange(stale, {
      source: "forgepilot",
      source_modified_at: "2026-11-14T09:04:00Z",
      recorded_at: "2026-11-14T09:04:00Z",
      fields: { title: "Latest local title" },
    });

    expect(stale).toBe(remote);
    expect(later.content.title).toBe("Latest local title");
    expect(later.versions.at(-1)?.source).toBe("forgepilot");
  });

  it("deduplicates comments and restores snapshots as new versions", () => {
    const first = history();
    const comment = {
      id: "comment-1",
      source: "github" as const,
      source_comment_id: "55",
      author: "alice",
      body: "Please investigate",
      created_at: "2026-11-14T09:02:00Z",
    };
    const withComment = applyIssueChange(first, {
      source: "github",
      source_modified_at: "2026-11-14T09:02:00Z",
      recorded_at: "2026-11-14T09:02:01Z",
      fields: {},
      comments: [comment],
    });
    const duplicate = applyIssueChange(withComment, {
      source: "github",
      source_modified_at: "2026-11-14T09:03:00Z",
      recorded_at: "2026-11-14T09:03:00Z",
      fields: {},
      comments: [comment],
    });
    const edited = applyIssueChange(duplicate, {
      source: "forgepilot",
      source_modified_at: "2026-11-14T09:04:00Z",
      recorded_at: "2026-11-14T09:04:00Z",
      fields: { title: "Changed title" },
    });
    const restored = rollbackIssueContent(
      edited,
      first.versions[0]!.version_id,
      "2026-11-14T09:05:00Z",
    );

    expect(duplicate.comments).toHaveLength(1);
    expect(restored.content).toEqual(initial);
    expect(restored.versions).toHaveLength(4);
    expect(restored.versions.at(-1)?.rollback_of).toBe(first.versions[0]!.version_id);
    expect(restored.comments).toHaveLength(1);
    expect(restored.field_modified_at.description).toBe("2026-11-14T09:00:00.000Z");
    expect(restored.field_modified_at.state).toBe("2026-11-14T09:00:00.000Z");
  });
});
