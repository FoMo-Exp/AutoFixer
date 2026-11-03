/**
 * Projections over trace records (DAT-224).
 *
 * A projection is a read-only view: it annotates, never edits. It is explicit
 * about what it cannot promise — freshness (`as_of` and the two watermarks),
 * missing ranges (gaps in a source's own sequence), late records (arrived
 * after their source had already recorded a higher sequence), and truncated
 * records (writer-marked). The merged `events` list is a display order by
 * `(event_time, source, sequence)`; the only ordering authority remains each
 * source's own sequence, so no single global order is implied.
 */
import type { TraceEvent } from "./schema.js";

export interface ProjectedTraceEvent extends TraceEvent {
  /** Arrival was later than this source's own ordering watermark. */
  late: boolean;
}

/** A gap inside one source's sequence: those records have not been seen. */
export interface MissingRange {
  source: string;
  from_sequence: number;
  to_sequence: number;
}

export interface ProjectionFreshness {
  /** The moment this view reflects; pinned by the caller or the ingest watermark. */
  as_of: string | null;
  event_time_watermark: string | null;
  ingest_time_watermark: string | null;
}

export interface ProjectionCompleteness {
  /** False when records are missing or truncated; late alone keeps data complete. */
  complete: boolean;
  missing: MissingRange[];
  late_event_ids: string[];
  truncated_event_ids: string[];
}

export interface TraceProjection {
  events: ProjectedTraceEvent[];
  freshness: ProjectionFreshness;
  completeness: ProjectionCompleteness;
}

/**
 * Project records given in arrival order (as `TraceStore.query` returns them).
 * The input is never mutated; late detection follows arrival, display order
 * follows event time.
 */
export function projectTraceEvents(
  events: readonly TraceEvent[],
  options: { as_of?: string } = {},
): TraceProjection {
  const maxSequenceBySource = new Map<string, number>();
  const sequencesBySource = new Map<string, number[]>();
  const projected: ProjectedTraceEvent[] = [];
  const lateEventIds: string[] = [];
  const truncatedEventIds: string[] = [];
  let eventTimeWatermark: string | null = null;
  let ingestTimeWatermark: string | null = null;

  for (const event of events) {
    const seenMax = maxSequenceBySource.get(event.source) ?? 0;
    const late = event.sequence < seenMax;
    if (late) {
      lateEventIds.push(event.event_id);
    }
    if (event.sequence > seenMax) {
      maxSequenceBySource.set(event.source, event.sequence);
    }
    const sequences = sequencesBySource.get(event.source) ?? [];
    sequences.push(event.sequence);
    sequencesBySource.set(event.source, sequences);
    if (event.truncated) {
      truncatedEventIds.push(event.event_id);
    }
    if (
      eventTimeWatermark === null ||
      Date.parse(event.event_time) > Date.parse(eventTimeWatermark)
    ) {
      eventTimeWatermark = event.event_time;
    }
    if (
      ingestTimeWatermark === null ||
      Date.parse(event.ingest_time) > Date.parse(ingestTimeWatermark)
    ) {
      ingestTimeWatermark = event.ingest_time;
    }
    projected.push({ ...event, late });
  }

  const missing: MissingRange[] = [];
  for (const [source, sequences] of sequencesBySource) {
    const sorted = [...new Set(sequences)].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous !== undefined && current !== undefined && current - previous > 1) {
        missing.push({ source, from_sequence: previous + 1, to_sequence: current - 1 });
      }
    }
  }

  const ordered = [...projected].sort((a, b) => {
    const byTime = Date.parse(a.event_time) - Date.parse(b.event_time);
    if (byTime !== 0) {
      return byTime;
    }
    if (a.source !== b.source) {
      return a.source < b.source ? -1 : 1;
    }
    return a.sequence - b.sequence;
  });

  return {
    events: ordered,
    freshness: {
      as_of: options.as_of ?? ingestTimeWatermark,
      event_time_watermark: eventTimeWatermark,
      ingest_time_watermark: ingestTimeWatermark,
    },
    completeness: {
      complete: missing.length === 0 && truncatedEventIds.length === 0,
      missing,
      late_event_ids: lateEventIds,
      truncated_event_ids: truncatedEventIds,
    },
  };
}
