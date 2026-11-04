import { describe, expect, test } from "vitest";

import { TraceValidationError } from "../src/trace/errors.js";
import {
  DENY_ALL_RETENTION_ADMIN,
  parseRetentionConfig,
  RetentionAdminDenied,
  RetentionAuthority,
  RetentionConfigError,
  RetentionRecordError,
  RetentionSchedule,
} from "../src/trace/retention.js";
import type { RetentionAdminAction, RetentionConfig } from "../src/trace/retention.js";

const CONFIG: RetentionConfig = {
  evidence_days: 30,
  trace_days: 14,
  content_days: 7,
  usage_days: 90,
  backup_days: 2,
};

function fixedClock(startMs: number): { now: () => Date; advance: (days: number) => void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (days: number) => {
      current += days * 86_400_000;
    },
  };
}

const CAPTURED_AT = "2026-11-03T00:00:00.000Z";
const START_MS = Date.parse(CAPTURED_AT);

/** A policy that authorizes every administration action for the given subjects. */
function allowAllPolicy(subjects: readonly string[]) {
  return {
    mayAct: (subject: string, _action: RetentionAdminAction) => subjects.includes(subject),
  };
}

describe("finite retention configuration", () => {
  test("every class needs its own finite whole-day bound", () => {
    const config = parseRetentionConfig(CONFIG);
    expect(config.content_days).toBe(7);
    expect(config.backup_days).toBe(2);
  });

  test("missing values are refused, never read as retain-forever", () => {
    const { usage_days: _omitted, ...partial } = CONFIG;
    expect(() => parseRetentionConfig(partial)).toThrow(RetentionConfigError);
    expect(() => parseRetentionConfig(undefined)).toThrow(RetentionConfigError);
    expect(() => parseRetentionConfig(null)).toThrow(RetentionConfigError);
  });

  test("infinite, zero, negative and fractional day counts are refused", () => {
    for (const bad of [Number.POSITIVE_INFINITY, 0, -1, 2.5, "7"]) {
      expect(() => parseRetentionConfig({ ...CONFIG, content_days: bad })).toThrow(
        RetentionConfigError,
      );
    }
  });
});

describe("expiry per record class", () => {
  test("each class expires on its own schedule, including backups", () => {
    const clock = fixedClock(START_MS);
    const schedule = new RetentionSchedule({
      config: CONFIG,
      authority: new RetentionAuthority(),
      now: clock.now,
    });
    for (const recordClass of ["evidence", "trace", "content", "usage", "backup"] as const) {
      schedule.register({
        id: `rec-${recordClass}`,
        record_class: recordClass,
        captured_at: CAPTURED_AT,
      });
    }

    clock.advance(3);
    // Backup retention (2 days) has elapsed; nothing else has.
    expect(schedule.expire().map((t) => t.id)).toEqual(["rec-backup"]);
    expect(
      schedule
        .records()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["rec-content", "rec-evidence", "rec-trace", "rec-usage"]);

    clock.advance(5);
    // Content retention (7 days) has now elapsed too.
    expect(schedule.expire().map((t) => t.id)).toEqual(["rec-content"]);

    clock.advance(100);
    const swept = schedule.expire().map((t) => t.id);
    expect(swept.sort()).toEqual(["rec-evidence", "rec-trace", "rec-usage"]);
  });

  test("expiry happens at the retention boundary, not after it", () => {
    const clock = fixedClock(START_MS);
    const schedule = new RetentionSchedule({
      config: CONFIG,
      authority: new RetentionAuthority(),
      now: clock.now,
    });
    schedule.register({ id: "rec-1", record_class: "backup", captured_at: CAPTURED_AT });

    clock.advance(2);
    expect(schedule.expire().map((t) => t.id)).toEqual(["rec-1"]);
    expect(schedule.tombstones()).toEqual([
      {
        id: "rec-1",
        record_class: "backup",
        reason: "expired",
        at: new Date(START_MS + 2 * 86_400_000).toISOString(),
        by: "system",
      },
    ]);
  });

  test("registering over a tombstoned id is refused", () => {
    const clock = fixedClock(START_MS);
    const schedule = new RetentionSchedule({
      config: CONFIG,
      authority: new RetentionAuthority(),
      now: clock.now,
    });
    schedule.register({ id: "rec-1", record_class: "backup", captured_at: CAPTURED_AT });
    clock.advance(2);
    schedule.expire();
    expect(() =>
      schedule.register({ id: "rec-1", record_class: "backup", captured_at: CAPTURED_AT }),
    ).toThrow(RetentionRecordError);
  });

  test("registering the same id twice is refused", () => {
    const schedule = new RetentionSchedule({
      config: CONFIG,
      authority: new RetentionAuthority(),
    });
    schedule.register({ id: "rec-1", record_class: "trace", captured_at: CAPTURED_AT });
    expect(() =>
      schedule.register({ id: "rec-1", record_class: "trace", captured_at: CAPTURED_AT }),
    ).toThrow(RetentionRecordError);
    expect(() =>
      schedule.register({ id: "rec-2", record_class: "nope" as "trace", captured_at: CAPTURED_AT }),
    ).toThrow(TraceValidationError);
    expect(() =>
      schedule.register({ id: "rec-3", record_class: "trace", captured_at: "yesterday" }),
    ).toThrow(TraceValidationError);
  });
});

describe("deletion under explicit policy", () => {
  test("deletion needs a grant minted for the actor and the action", () => {
    const authority = new RetentionAuthority(allowAllPolicy(["ops"]));
    const schedule = new RetentionSchedule({ config: CONFIG, authority });
    schedule.register({ id: "rec-1", record_class: "trace", captured_at: CAPTURED_AT });

    // No grant, a caller-built grant, and another authority's grant all fail.
    expect(() => schedule.delete("rec-1", "ops", null)).toThrow(RetentionAdminDenied);
    expect(() =>
      schedule.delete("rec-1", "ops", { subject: "ops", action: "delete" } as never),
    ).toThrow(RetentionAdminDenied);
    const foreignGrant = new RetentionAuthority(allowAllPolicy(["ops"])).authorize("ops", "delete");
    expect(() => schedule.delete("rec-1", "ops", foreignGrant)).toThrow(RetentionAdminDenied);

    // A grant for the wrong action or the wrong actor fails too.
    const holdGrant = authority.authorize("ops", "place_legal_hold");
    expect(() => schedule.delete("rec-1", "ops", holdGrant)).toThrow(RetentionAdminDenied);
    const grant = authority.authorize("ops", "delete");
    expect(() => schedule.delete("rec-1", "someone-else", grant)).toThrow(RetentionAdminDenied);
  });

  test("the default policy denies every administration action", () => {
    const authority = new RetentionAuthority();
    expect(() => authority.authorize("ops", "delete")).toThrow(RetentionAdminDenied);
    const explicit = new RetentionAuthority(DENY_ALL_RETENTION_ADMIN);
    expect(() => explicit.authorize("ops", "place_legal_hold")).toThrow(RetentionAdminDenied);
  });

  test("deletion writes a minimal tombstone and auditable history", () => {
    const authority = new RetentionAuthority(allowAllPolicy(["ops"]));
    const clock = fixedClock(START_MS);
    const schedule = new RetentionSchedule({ config: CONFIG, authority, now: clock.now });
    schedule.register({ id: "rec-1", record_class: "content", captured_at: CAPTURED_AT });

    clock.advance(1);
    const tombstone = schedule.delete(
      "rec-1",
      "ops",
      authority.authorize("ops", "delete"),
      "user erasure request",
    );
    expect(tombstone).toEqual({
      id: "rec-1",
      record_class: "content",
      reason: "deleted",
      at: new Date(START_MS + 86_400_000).toISOString(),
      by: "ops",
    });
    // Tombstones carry identity and reason only: no content, hashes, provenance.
    expect(Object.keys(tombstone).sort()).toEqual(["at", "by", "id", "reason", "record_class"]);
    expect(schedule.records()).toHaveLength(0);

    // Deleting again fails loudly instead of rewriting anything.
    expect(() => schedule.delete("rec-1", "ops", authority.authorize("ops", "delete"))).toThrow(
      RetentionRecordError,
    );
    const audit = schedule.audit();
    expect(audit.map((entry) => entry.action)).toEqual(["captured", "deleted"]);
    expect(audit[1]?.detail).toBe("user erasure request");
  });
});

describe("legal hold under explicit policy", () => {
  function setup() {
    const authority = new RetentionAuthority(allowAllPolicy(["legal"]));
    const clock = fixedClock(START_MS);
    const schedule = new RetentionSchedule({ config: CONFIG, authority, now: clock.now });
    schedule.register({ id: "rec-1", record_class: "backup", captured_at: CAPTURED_AT });
    return { authority, clock, schedule };
  }

  test("a held record survives expiry and cannot be deleted", () => {
    const { authority, clock, schedule } = setup();
    expect(() => schedule.placeLegalHold("rec-1", "legal", null, "litigation")).toThrow(
      RetentionAdminDenied,
    );

    schedule.placeLegalHold(
      "rec-1",
      "legal",
      authority.authorize("legal", "place_legal_hold"),
      "litigation",
    );
    clock.advance(10);
    // Past its 2-day backup retention, but the hold keeps it.
    expect(schedule.expire()).toHaveLength(0);
    expect(schedule.records()[0]?.legal_hold?.reason).toBe("litigation");
    expect(() => schedule.delete("rec-1", "legal", authority.authorize("legal", "delete"))).toThrow(
      RetentionRecordError,
    );
  });

  test("releasing the hold restores ordinary expiry", () => {
    const { authority, clock, schedule } = setup();
    schedule.placeLegalHold(
      "rec-1",
      "legal",
      authority.authorize("legal", "place_legal_hold"),
      "litigation",
    );
    clock.advance(10);
    schedule.expire();
    expect(schedule.records()).toHaveLength(1);

    schedule.releaseLegalHold(
      "rec-1",
      "legal",
      authority.authorize("legal", "release_legal_hold"),
      "matter closed",
    );
    expect(schedule.expire().map((t) => t.reason)).toEqual(["expired"]);
    expect(schedule.records()).toHaveLength(0);
  });

  test("hold lifecycle is conflict-checked and audited", () => {
    const { authority, schedule } = setup();
    const place = authority.authorize("legal", "place_legal_hold");
    schedule.placeLegalHold("rec-1", "legal", place, "litigation");
    expect(() => schedule.placeLegalHold("rec-1", "legal", place, "again")).toThrow(
      RetentionRecordError,
    );
    expect(() =>
      schedule.releaseLegalHold(
        "rec-1",
        "legal",
        authority.authorize("legal", "release_legal_hold"),
      ),
    ).not.toThrow();
    expect(() =>
      schedule.releaseLegalHold(
        "rec-1",
        "legal",
        authority.authorize("legal", "release_legal_hold"),
      ),
    ).toThrow(RetentionRecordError);
    expect(schedule.audit().map((entry) => entry.action)).toEqual([
      "captured",
      "legal_hold_placed",
      "legal_hold_released",
    ]);
  });
});

describe("historical audit is never rewritten", () => {
  test("deletion, expiry and tombstones only append to the audit trail", () => {
    const authority = new RetentionAuthority(allowAllPolicy(["ops"]));
    const clock = fixedClock(START_MS);
    const schedule = new RetentionSchedule({ config: CONFIG, authority, now: clock.now });
    schedule.register({ id: "rec-1", record_class: "backup", captured_at: CAPTURED_AT });
    schedule.register({ id: "rec-2", record_class: "backup", captured_at: CAPTURED_AT });
    schedule.delete("rec-2", "ops", authority.authorize("ops", "delete"));

    const before = schedule.audit();
    clock.advance(3);
    schedule.expire();
    const after = schedule.audit();

    // Every entry recorded before the sweep is still there, byte-identical.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((entry) => entry.action)).toEqual([
      "captured",
      "captured",
      "deleted",
      "expired",
    ]);
    expect(
      schedule
        .tombstones()
        .map((t) => t.reason)
        .sort(),
    ).toEqual(["deleted", "expired"]);
  });

  test("audit reads return defensive copies", () => {
    const schedule = new RetentionSchedule({ config: CONFIG, authority: new RetentionAuthority() });
    schedule.register({ id: "rec-1", record_class: "trace", captured_at: CAPTURED_AT });
    const entries = schedule.audit();
    // Tamper with the returned copy; the stored entry must be unaffected.
    Object.assign(entries[0]!, { action: "deleted" });
    entries.push({ at: "x", action: "deleted", record_id: "x", actor: "x", detail: null });
    expect(schedule.audit()).toHaveLength(1);
    expect(schedule.audit()[0]?.action).toBe("captured");
  });
});
