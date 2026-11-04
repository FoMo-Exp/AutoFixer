import { useEffect, useRef, useState } from "react";
import type { ForgePilotClient, IssueEvent } from "./client";

export type IssueStreamConnection =
  "idle" | "connecting" | "connected" | "reconnecting" | "offline";

export interface IssueStreamState {
  events: IssueEvent[];
  connection: IssueStreamConnection;
  error: string | undefined;
  /** Events the replay delivered again; suppressed, never rendered twice. */
  duplicates: number;
  /** Times a sequence gap forced a full replay from the retained log. */
  gapRecoveries: number;
  terminal: boolean;
}

const INITIAL_STATE: IssueStreamState = {
  events: [],
  connection: "idle",
  error: undefined,
  duplicates: 0,
  gapRecoveries: 0,
  terminal: false,
};

/**
 * Merge one replay batch into the local event log.
 *
 * `event_id` is the contract's replay-stable idempotency key, so a replayed
 * frame is dropped instead of rendered twice; `sequence` is the ordering
 * cursor. A batch that skips a sequence number is reported as a gap so the
 * caller can request a full replay rather than silently keep a hole.
 */
export function mergeIssueEvents(
  current: IssueEvent[],
  incoming: readonly IssueEvent[],
): { events: IssueEvent[]; added: number; duplicates: number; gap: boolean } {
  const byId = new Map(current.map((event) => [event.event_id, event]));
  let maxSequence = current.reduce((max, event) => Math.max(max, event.sequence), 0);
  let added = 0;
  let duplicates = 0;
  let gap = false;
  for (const event of incoming) {
    if (byId.has(event.event_id)) {
      duplicates += 1;
      continue;
    }
    // Sequence 1 is the first event; only a hole after an observed event is a gap.
    if (maxSequence > 0 && event.sequence > maxSequence + 1) gap = true;
    byId.set(event.event_id, event);
    maxSequence = Math.max(maxSequence, event.sequence);
    added += 1;
  }
  if (added === 0) return { events: current, added, duplicates, gap };
  const events = [...byId.values()].sort((left, right) => left.sequence - right.sequence);
  return { events, added, duplicates, gap };
}

/**
 * Durable issue event stream with `Last-Event-ID` replay.
 *
 * An absent anchor makes the service replay the retained log from the start;
 * after that the hook sends the newest delivered id. Duplicates are collapsed
 * on `event_id`, ordering is by `sequence`, and a detected sequence hole
 * reconnects without an anchor so the durable projection fills the gap. The
 * stream stops after `issue.terminal` and never invents state the service did
 * not send.
 */
export function useIssueStream(
  client: ForgePilotClient,
  workspaceId: string | undefined,
  issueId: string | undefined,
): IssueStreamState {
  const [state, setState] = useState<IssueStreamState>(INITIAL_STATE);
  const connectionRef = useRef<IssueStreamConnection>("idle");
  const setConnection = (connection: IssueStreamConnection): void => {
    if (connectionRef.current === connection) return;
    connectionRef.current = connection;
    setState((current) => ({ ...current, connection }));
  };

  useEffect(() => {
    if (!workspaceId || !issueId) {
      connectionRef.current = "idle";
      setState(INITIAL_STATE);
      return;
    }

    connectionRef.current = "connecting";
    setState({ ...INITIAL_STATE, connection: "connecting" });
    let stopped = false;
    let lastEventId: string | undefined;
    let delay = 1000;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let events = [] as IssueEvent[];
    let gapDetected = false;

    const sleep = (ms: number): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      timer = window.setTimeout(resolve, ms);
      return promise;
    };

    const addEvent = (event: IssueEvent): void => {
      const merged = mergeIssueEvents(events, [event]);
      events = merged.events;
      // Advance the replay anchor on every delivered frame: a network error
      // may abort before the stream call returns, and reconnecting from a
      // stale anchor would replay the whole retained log.
      const newest = merged.events.at(-1);
      if (newest) lastEventId = newest.event_id;
      setState((current) => ({
        ...current,
        events: merged.events,
        duplicates: current.duplicates + merged.duplicates,
        terminal: current.terminal || event.type === "issue.terminal",
      }));
      if (merged.gap) {
        gapDetected = true;
        controller?.abort();
      }
    };

    const connect = async (): Promise<void> => {
      while (!stopped) {
        const attempt = new AbortController();
        controller = attempt;
        gapDetected = false;
        setConnection(lastEventId ? "reconnecting" : "connecting");
        try {
          const result = await client.streamIssueEvents(workspaceId, issueId, {
            ...(lastEventId ? { lastEventId } : {}),
            signal: attempt.signal,
            onOpen: () => {
              setState((current) => ({ ...current, error: undefined }));
              setConnection("connected");
            },
            onEvent: addEvent,
          });
          if (stopped) return;
          if (result.lastEventId) lastEventId = result.lastEventId;
          setState((current) => ({ ...current, error: undefined }));
          if (gapDetected) {
            lastEventId = undefined;
            setState((current) => ({
              ...current,
              gapRecoveries: current.gapRecoveries + 1,
            }));
            continue;
          }
          if (result.terminal) {
            setState((current) => ({ ...current, terminal: true }));
            setConnection("connected");
            return;
          }
          setConnection("reconnecting");
        } catch (caught) {
          if (stopped) return;
          if (gapDetected) {
            lastEventId = undefined;
            setState((current) => ({
              ...current,
              gapRecoveries: current.gapRecoveries + 1,
              error: undefined,
            }));
            continue;
          }
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setState((current) => ({
            ...current,
            error: caught instanceof Error ? caught.message : "Issue stream disconnected.",
          }));
          setConnection("offline");
          await sleep(delay);
          delay = Math.min(delay * 2, 15_000);
          continue;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
      }
    };

    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [client, workspaceId, issueId]);

  return state;
}
