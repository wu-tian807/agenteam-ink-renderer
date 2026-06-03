/**
 * @desc IDE Bridge client — connect to VS Code extension local WebSocket for snippets.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SnippetPayload } from "./snippet-ingest.js";

export interface IdeBridgeLock {
  port: number;
  token: string;
  workspaceFolders?: string[];
  updatedAt?: number;
}

const LOCK_STALE_MS = 60_000;
const IDE_DIR = join(homedir(), ".agenteam", "ide");

/** Pick the best lock file for the current working directory. */
export function discoverIdeLock(cwd: string): IdeBridgeLock | null {
  let entries: string[];
  try {
    entries = readdirSync(IDE_DIR).filter((f) => f.endsWith(".lock"));
  } catch {
    return null;
  }

  const now = Date.now();
  const locks: IdeBridgeLock[] = [];

  for (const file of entries) {
    try {
      const raw = readFileSync(join(IDE_DIR, file), "utf-8");
      const lock = JSON.parse(raw) as IdeBridgeLock;
      if (typeof lock.port !== "number" || typeof lock.token !== "string") continue;
      if (lock.updatedAt != null && now - lock.updatedAt > LOCK_STALE_MS) continue;
      locks.push(lock);
    } catch { /* skip invalid */ }
  }

  if (locks.length === 0) return null;

  const envPort = process.env.AGENTEAM_IDE_PORT;
  if (envPort) {
    const port = Number(envPort);
    const match = locks.find((l) => l.port === port);
    if (match) return match;
  }

  const cwdNorm = cwd.replace(/\\/g, "/");
  const byWorkspace = locks.filter((l) =>
    l.workspaceFolders?.some((folder) => {
      const f = folder.replace(/\\/g, "/");
      return cwdNorm === f || cwdNorm.startsWith(f + "/");
    }),
  );
  if (byWorkspace.length === 1) return byWorkspace[0]!;
  if (byWorkspace.length > 1) {
    return byWorkspace.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
  }

  if (locks.length === 1) return locks[0]!;

  return locks.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
}

export interface IdeBridgeClientHandlers {
  onSnippet: (payload: SnippetPayload) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export interface IdeBridgeConnection {
  sendFocusState(focused: boolean): void;
  close(): void;
}

/** Connect to the IDE bridge; returns null if connection fails. */
export async function connectIdeBridge(
  lock: IdeBridgeLock,
  handlers: IdeBridgeClientHandlers,
  opts?: { cwd?: string; instanceId?: string },
): Promise<IdeBridgeConnection | null> {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${lock.port}`);

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("IDE bridge connect timeout")), 5_000);
      const onMessage = (raw: Buffer) => {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(raw.toString("utf-8")); } catch { return; }
        if (frame.type === "auth_ok") {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve();
          return;
        }
        if (frame.type === "error") {
          clearTimeout(timer);
          ws.off("message", onMessage);
          reject(new Error(String(frame.message)));
        }
      };
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", token: lock.token }));
      });
      ws.on("message", onMessage);
      ws.once("error", (err) => { clearTimeout(timer); reject(err); });
    });
  } catch {
    ws.close();
    return null;
  }

  ws.send(JSON.stringify({
    type: "register",
    cwd: opts?.cwd ?? process.cwd(),
    instanceId: opts?.instanceId,
  }));

  ws.on("message", (raw: Buffer) => {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw.toString("utf-8")); } catch { return; }
    if (frame.type === "snippet") {
      const pathVal = frame.path;
      const content = frame.content;
      if (typeof pathVal !== "string" || typeof content !== "string") return;
      handlers.onSnippet({
        path: pathVal,
        content,
        lineStart: typeof frame.lineStart === "number" ? frame.lineStart : undefined,
        lineEnd: typeof frame.lineEnd === "number" ? frame.lineEnd : undefined,
        language: typeof frame.language === "string" ? frame.language : undefined,
      });
    }
  });

  ws.once("close", () => handlers.onDisconnected?.());
  handlers.onConnected?.();

  return {
    sendFocusState(focused: boolean) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: "focus_state", focused, ts: Date.now() }));
    },
    close() {
      ws.close(1000);
    },
  };
}
