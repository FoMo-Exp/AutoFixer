import { useEffect, useRef, useState } from "react";
import type { ForgePilotClient, TaskEvent } from "./client";

export type StreamConnection = "idle" | "connecting" | "connected" | "reconnecting" | "offline";

export function sanitizeStreamEvent(event: TaskEvent): TaskEvent {
  if (event.type !== "pi.text_delta") return event;
  return { ...event, data: { ...event.data, delta: "" } };
}

export function useTaskStream(
  client: ForgePilotClient,
  taskId: string | undefined,
  onEvent?: (event: TaskEvent) => void,
  terminal = false,
): { events: TaskEvent[]; connection: StreamConnection; error: string | undefined } {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [connection, setConnection] = useState<StreamConnection>("idle");
  const [error, setError] = useState<string>();
  const onEventRef = useRef(onEvent);
  const terminalRef = useRef(terminal);
  const activeTaskIdRef = useRef<string | undefined>(undefined);
  onEventRef.current = onEvent;
  terminalRef.current = terminal;

  useEffect(() => {
    if (!taskId) {
      activeTaskIdRef.current = undefined;
      setEvents([]);
      setConnection("idle");
      setError(undefined);
      return;
    }

    if (activeTaskIdRef.current !== taskId) {
      activeTaskIdRef.current = taskId;
      setEvents([]);
    }

    let stopped = false;
    const controller = new AbortController();
    let reconnectTimer: number | undefined;
    let lastEventId: string | undefined;
    let delay = 1000;

    const addEvent = (incoming: TaskEvent): void => {
      if (stopped) return;
      const event = sanitizeStreamEvent(incoming);
      lastEventId = event.event_id;
      setEvents((current) => {
        if (current.some((item) => item.event_id === event.event_id)) return current;
        return [...current, event].sort((left, right) => left.sequence - right.sequence);
      });
      onEventRef.current?.(event);
    };

    const connect = async (): Promise<void> => {
      if (stopped) return;
      setConnection(delay === 1000 ? "connecting" : "reconnecting");
      try {
        if (!lastEventId) {
          const timeline = await client.getTimeline(taskId);
          if (stopped) return;
          for (const event of timeline) addEvent(event);
          lastEventId = timeline.at(-1)?.event_id;
        }
        if (terminalRef.current) {
          setConnection("connected");
          return;
        }
        const result = await client.streamTaskEvents(taskId, {
          lastEventId,
          signal: controller.signal,
          onEvent: addEvent,
        });
        if (stopped) return;
        lastEventId = result.lastEventId;
        if (result.terminal) {
          setConnection("connected");
          return;
        }
        setConnection("reconnecting");
        reconnectTimer = window.setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, 15_000);
      } catch (caught) {
        if (stopped) return;
        setError(caught instanceof Error ? caught.message : "Task stream disconnected.");
        setConnection("reconnecting");
        reconnectTimer = window.setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, 15_000);
      }
    };

    setError(undefined);
    void connect();
    return () => {
      stopped = true;
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  }, [client, taskId]);

  return { events, connection, error };
}
