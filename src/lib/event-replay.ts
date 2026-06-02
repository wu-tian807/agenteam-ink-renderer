/**
 * Event replay — parse JSONL event streams and rebuild CompletedTurn[]
 * by feeding events through the shared TurnAccumulator.
 *
 * parseEventLines / replayEvents yield to the event loop every
 * YIELD_CHUNK items so the input box and animations stay responsive
 * during large history replays.
 *
 * isRunning is accepted externally (from TeamBoard) rather than
 * inferred from turnStart/turnEnd event pairing.
 */

import type { StoredEvent, CompletedTurn, ToolCallMessage } from "../types.js";
import { TurnAccumulator } from "./turn-accumulator.js";

export interface ReplayResult {
  turns: CompletedTurn[];
  sessionId: string | null;
  contextPct: number;
}

const YIELD_CHUNK = 150;

function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export async function parseEventLines(raw: string): Promise<StoredEvent[]> {
  const lines = raw.split("\n");
  const events: StoredEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as StoredEvent;
      if (typeof rec.type === "string") events.push(rec);
    } catch { /* skip malformed */ }
    if (i % YIELD_CHUNK === 0 && i > 0) await yieldToEventLoop();
  }
  return events;
}

/**
 * Trim events to clean turn boundaries: discard orphan events before
 * the first turnStart/user_input so partial tail loads don't produce
 * malformed turns.
 */
export function trimToTurnBoundary(events: StoredEvent[]): StoredEvent[] {
  const firstBoundary = events.findIndex(
    e => e.type === "hook:turnStart" || (e as any).source === "user",
  );
  return firstBoundary > 0 ? events.slice(firstBoundary) : events;
}

export async function replayEvents(events: StoredEvent[], viewerId?: string): Promise<ReplayResult> {
  const turns: CompletedTurn[] = [];
  let sessionId: string | null = null;
  let contextPct = 0;

  const acc = new TurnAccumulator({
    onTurn: (turn) => turns.push(turn),
    onUpdateMessage: (callId, merged) => {
      for (let i = turns.length - 1; i >= 0; i--) {
        const msgs = turns[i]!.messages;
        for (let j = msgs.length - 1; j >= 0; j--) {
          const m = msgs[j]!;
          if (m.kind === "tool_call" && (m as ToolCallMessage).id === callId) {
            msgs[j] = { ...m, ...merged };
            return;
          }
        }
      }
    },
    onMeta: (m) => {
      if (m.session) sessionId = m.session;
      if (m.contextPct !== undefined) contextPct = m.contextPct;
    },
  }, viewerId);

  for (let i = 0; i < events.length; i++) {
    acc.feed(events[i]!);
    if (i % YIELD_CHUNK === 0 && i > 0) await yieldToEventLoop();
  }
  acc.flush();

  return { turns, sessionId, contextPct };
}
