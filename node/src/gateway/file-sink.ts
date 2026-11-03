import fs from "node:fs";
import path from "node:path";

import type { GatewayAttemptEvent, GatewayEventSink } from "./types.js";

/**
 * Durable deployment-grade event sink: one JSONL line per gateway attempt
 * record. A write failure propagates to the gateway, which blocks the dispatch
 * when the failing record is the required pre-dispatch evidence.
 */
export function createFileEventSink(file: string): GatewayEventSink {
  fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
  return {
    record(event: GatewayAttemptEvent): void {
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    },
  };
}
