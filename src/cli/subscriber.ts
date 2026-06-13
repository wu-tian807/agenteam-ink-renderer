/**
 * @desc Ink Renderer subscriber — connects to Gateway via plain WS, renders TUI via React/Ink.
 *
 * Self-contained: connection lifecycle, command RPC, event fan-out, draft cache,
 * dataSource/callbacks adapters, and InkRenderer launch all live here. The CLI
 * entrypoint in `./index.ts` simply constructs an instance and calls `start()`.
 *
 * Switching instances from inside the TUI just updates a local
 * `currentInstanceId` (no server notification needed — Gateway broadcasts every
 * instance event to every authed WS client and the subscriber filters locally).
 */

import { join } from "node:path";
import type WebSocket from "ws";
import {
  loadConnInfo, apiCall, connectGatewayWs,
  clearScreen, setMediasDir, listInstances, resolveInstanceId,
  type ConnInfo, type CommandSpec, type CommandResult, type AgentNodeData,
} from "@agenteam/types";
import {
  rendererCacheStore,
  type InkCache,
} from "../lib/renderer-cache-store.js";
import type {
  RendererCallbacks,
  RendererDataSource,
  DraftSnapshot,
  SnippetPayload,
} from "../lib/renderer-config.js";
import {
  startIdeBridgeSubscriber,
  type IdeBridgeSubscriberHandle,
} from "../lib/ide-bridge-subscriber.js";
import { InkRenderer } from "../index.js";
import { applyDraft } from "./draft-cache.js";

export interface SubscriberOptions {
  /** Resolved ~/.agenteam directory (state dir). */
  stateDir: string;
  /** Initial instance id; "" means "fall back to gateway resolveInstanceId". */
  instanceId: string;
}

export class InkRendererSubscriber {
  private renderer: InkRenderer | null = null;
  private observers = new Set<(event: Record<string, unknown>, emitterId?: string) => void>();
  private snippetObservers = new Set<(payload: SnippetPayload) => void>();
  private ideBridge: IdeBridgeSubscriberHandle | null = null;
  private currentInstanceId: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private readonly conn: ConnInfo;
  private readonly stateDir: string;
  /** Pending command RPCs: requestId → resolver (30s timeout, then rejects). */
  private pendingCommands = new Map<string, (result: CommandResult) => void>();
  /** Pending emit ack RPCs: requestId → resolver. Mirrors pendingCommands but
   *  carries DeliveryResult for the user-input → worker EventBus path. */
  private pendingEmits = new Map<string, (result: { ok: boolean; error?: string }) => void>();
  private nextRequestId = 0;
  /** Per-emit ack timeout. Old gateways pre-dating the emit_ok/emit_error
   *  frames never reply at all — we fall back to optimistic ok:true after
   *  this many ms so the renderer doesn't hang on every send. New gateways
   *  reply in <5ms typical, well within the budget. */
  private static readonly EMIT_ACK_TIMEOUT_MS = 1000;

  private static readonly BASE_DELAY_MS = 2_000;
  private static readonly MAX_DELAY_MS = 30_000;

  constructor(opts: SubscriberOptions) {
    this.currentInstanceId = opts.instanceId;
    this.stateDir = opts.stateDir;
    this.conn = loadConnInfo(opts.stateDir);
  }

  async start(): Promise<void> {
    const self = this;
    this.ideBridge = startIdeBridgeSubscriber({
      onSnippet(payload) {
        for (const h of self.snippetObservers) {
          try { h(payload); } catch { /* ignore */ }
        }
      },
      isStopped: () => self.stopped,
      getInstanceId: () => self.currentInstanceId,
    });
    await this.connect();
  }

  /** Connect WS → spawn event loop + close handler → run business init. */
  private async connect(): Promise<void> {
    const newWs = await connectGatewayWs(this.conn);
    this.ws = newWs;
    this.reconnectAttempt = 0;

    newWs.on("message", (raw: Buffer) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw.toString("utf-8")); } catch { return; }
      if (frame.type === "command_result") {
        const requestId = frame.requestId as string | undefined;
        if (!requestId) return;
        const resolve = this.pendingCommands.get(requestId);
        if (!resolve) return;
        this.pendingCommands.delete(requestId);
        resolve(frame.result as CommandResult);
        return;
      }
      if (frame.type === "emit_ok") {
        const requestId = frame.requestId as string | undefined;
        if (!requestId) return;
        const resolve = this.pendingEmits.get(requestId);
        if (!resolve) return;
        this.pendingEmits.delete(requestId);
        resolve({ ok: true });
        return;
      }
      if (frame.type === "emit_error") {
        const requestId = frame.requestId as string | undefined;
        if (!requestId) return;
        const resolve = this.pendingEmits.get(requestId);
        if (!resolve) return;
        this.pendingEmits.delete(requestId);
        resolve({ ok: false, error: frame.reason as string | undefined });
        return;
      }
      if (frame.type !== "event" || (frame.instanceId != null && frame.instanceId !== this.currentInstanceId) || !frame.event) return;
      const event = frame.event as Record<string, unknown>;
      const emitterId = frame.emitterId as string | undefined;
      for (const h of this.observers) {
        try { h(event, emitterId); } catch {}
      }
    });

    newWs.on("close", (code: number) => {
      if (this.stopped || code === 1000 || code === 4001) return;
      this.renderer?.setConnectionState(false);
      void this.reconnect();
    });

    await this.onReady();
  }

  /** Exponential-backoff reconnect (2s → 30s cap). Stops on `stopped` flag. */
  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    this.reconnectAttempt++;
    const delay = Math.min(
      InkRendererSubscriber.BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt - 1),
      InkRendererSubscriber.MAX_DELAY_MS,
    );
    await new Promise((r) => setTimeout(r, delay));
    if (this.stopped) return;
    try {
      await this.connect();
    } catch (err) {
      process.stderr.write(`[ink-renderer] reconnect failed: ${(err as Error)?.message ?? String(err)}\n`);
      void this.reconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ideBridge?.stop();
    this.ideBridge = null;
    this.snippetObservers.clear();
    this.renderer?.stop();
    this.renderer = null;
    this.observers.clear();
    for (const resolve of this.pendingCommands.values()) {
      resolve({ ok: false, error: "Subscriber stopped" });
    }
    this.pendingCommands.clear();
    for (const resolve of this.pendingEmits.values()) {
      resolve({ ok: false, error: "Subscriber stopped" });
    }
    this.pendingEmits.clear();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }

  /** Local filter switch — no server notification (Gateway broadcasts all). */
  private setInstanceId(newId: string): void {
    this.currentInstanceId = newId;
  }

  /** Send an emit frame and await the gateway's reply (`emit_ok` /
   *  `emit_error`). If no reply arrives within EMIT_ACK_TIMEOUT_MS the renderer
   *  falls back to optimistic ok:true — this preserves backward compat with
   *  pre-emit-ack gateways that never reply, while modern gateways always
   *  respond well inside the budget (<5ms typical).
   *
   *  Never rejects — errors are always returned as { ok: false, error }. */
  private sendEmit(event: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) {
        resolve({ ok: false, error: "WS not connected" });
        return;
      }
      const requestId = `emit-${++this.nextRequestId}-${Date.now()}`;
      let timer: NodeJS.Timeout | null = null;
      const wrappedResolve = (result: { ok: boolean; error?: string }) => {
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      this.pendingEmits.set(requestId, wrappedResolve);
      timer = setTimeout(() => {
        // Old gateway never replies. Optimistic fallback: assume ok.
        if (this.pendingEmits.has(requestId)) {
          this.pendingEmits.delete(requestId);
          wrappedResolve({ ok: true });
        }
      }, InkRendererSubscriber.EMIT_ACK_TIMEOUT_MS);
      this.ws.send(JSON.stringify({
        type: "emit",
        instanceId: this.currentInstanceId,
        requestId,
        event,
      }));
    });
  }

  /**
   * Command RPC roundtrip. Resolves on matching `command_result` or 30s timeout.
   * Never rejects — errors are always wrapped as { ok: false, error }.
   */
  private sendCommandRequest(
    type: "list_commands" | "command_query" | "command_execute",
    payload: Record<string, unknown>,
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) {
        resolve({ ok: false, error: "WS not connected" });
        return;
      }
      const requestId = `cmd-${++this.nextRequestId}-${Date.now()}`;
      let timer: NodeJS.Timeout | null = null;
      const wrappedResolve = (result: CommandResult) => {
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      this.pendingCommands.set(requestId, wrappedResolve);
      timer = setTimeout(() => {
        if (this.pendingCommands.has(requestId)) {
          this.pendingCommands.delete(requestId);
          wrappedResolve({ ok: false, error: "Command timeout (30s)" });
        }
      }, 30_000);
      this.ws.send(JSON.stringify({
        type,
        instanceId: this.currentInstanceId,
        requestId,
        ...payload,
      }));
    });
  }

  /** Build the RendererDataSource that wraps WS RPC + HTTP API for this subscriber. */
  private buildDataSource(): RendererDataSource {
    const self = this;
    const conn = this.conn;
    return {
      async listAgents() {
        const r = await self.sendCommandRequest("command_query", { name: "list_agents", args: [] });
        if (!r.ok) return [];
        return ((r.data as Array<{ id: string }>) ?? []).map((n) => n.id);
      },
      async listSessions(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "list_sessions", args: [agentId] });
        if (!r.ok) return [];
        return ((r.data as Record<string, unknown>)?.sessions as string[]) ?? [];
      },
      async fetchAllEvents(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "fetch_session_events", args: [agentId] });
        if (!r.ok) return "";
        return typeof r.data === "string" ? r.data : "";
      },
      readRendererState() {
        return {};
      },
      async writeRendererActiveAgent(agent: string) {
        rendererCacheStore.update((cache: InkCache) => {
          if (!cache.agentByInstance) cache.agentByInstance = {};
          cache.agentByInstance[self.currentInstanceId] = agent;
        });
      },
      async fetchDefaultAgent() {
        const r = await self.sendCommandRequest("command_query", { name: "fetch_default_agent", args: [] });
        if (!r.ok) return null;
        return typeof r.data === "string" ? r.data : null;
      },
      async fetchControlOverview() {
        try {
          const { status, data } = await apiCall(conn, "GET", `/api/instances/${encodeURIComponent(self.currentInstanceId)}/control-plane/overview`);
          if (status >= 400) return null;
          return JSON.stringify((data as Record<string, unknown>).overview ?? data, null, 2);
        } catch { return null; }
      },
      async listInstances() {
        // Forward the full InstanceInfo[] verbatim. Stripping fields here
        // silently drops `hasTeam`, which startup-flow needs to distinguish
        // "no pack" from "worker still starting".
        return listInstances(conn);
      },
      readCachedAgent(instanceId: string) {
        return rendererCacheStore.snapshot().agentByInstance?.[instanceId] ?? null;
      },
      async writeCachedAgent(instanceId: string, agent: string) {
        rendererCacheStore.update((cache: InkCache) => {
          if (!cache.agentByInstance) cache.agentByInstance = {};
          cache.agentByInstance[instanceId] = agent;
        });
      },
      readDraft(instanceId: string, agent: string) {
        return rendererCacheStore.snapshot().drafts?.[instanceId]?.[agent] ?? null;
      },
      async writeDraft(instanceId: string, agent: string, draft: DraftSnapshot) {
        rendererCacheStore.update((cache: InkCache) => applyDraft(cache, instanceId, agent, draft));
      },
      writeDraftSync(instanceId: string, agent: string, draft: DraftSnapshot) {
        let changed = false;
        rendererCacheStore.update((cache: InkCache) => {
          changed = applyDraft(cache, instanceId, agent, draft);
          return changed;
        });
        if (changed) rendererCacheStore.flushSync();
      },
      async isAgentRunning(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "is_agent_running", args: [agentId] });
        if (!r.ok) return false;
        return r.data === true;
      },
      async getAgentStatus(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "get_agent_status", args: [agentId] });
        if (!r.ok) return "";
        return typeof r.data === "string" ? r.data : "";
      },
      async fetchAgentTree() {
        const r = await self.sendCommandRequest("command_query", { name: "fetch_agent_tree", args: [] });
        if (!r.ok) return [];
        return (r.data as AgentNodeData[]) ?? [];
      },
      async fetchTeamBoard(agentId?: string) {
        const args: string[] = agentId ? [agentId] : [];
        const r = await self.sendCommandRequest("command_query", { name: "fetch_teamboard", args });
        if (!r.ok) return {};
        return (r.data as Record<string, Record<string, unknown>>) ?? {};
      },
      async fetchAgentJson(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "fetch_agent_json", args: [agentId] });
        if (!r.ok) return null;
        return (r.data as Record<string, unknown>) ?? null;
      },
      async listAvailableModels() {
        try {
          const { status, data } = await apiCall(conn, "GET", "/api/models");
          if (status >= 400) return [];
          return Object.keys((data as Record<string, unknown>) ?? {}).sort();
        } catch { return []; }
      },
      async readAgentOverrides(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "read_agent_overrides", args: [agentId] });
        if (!r.ok) return {};
        return (r.data as Record<string, unknown>) ?? {};
      },
      async addInstance(id: string) {
        const { status, data } = await apiCall(conn, "POST", "/api/instances", { id }, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Failed to create instance (${status})`);
        const d = data as Record<string, unknown>;
        return { id: (d.id as string) ?? id, status: (d.status as string) ?? "unknown" };
      },
      async freeInstance(id: string) {
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(id)}/free`, undefined, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Failed to free instance (${status})`);
      },
      async freeAgent(_instanceId: string, agentId: string) {
        // _instanceId is part of the legacy interface but unused here —
        // sendCommandRequest internally uses self.currentInstanceId.
        const r = await self.sendCommandRequest("command_execute", { name: "delete-agent", args: [agentId] });
        if (!r.ok) throw new Error(r.error ?? "Failed to free agent");
      },
      async listPacks() {
        const { status, data } = await apiCall(conn, "GET", "/api/packs");
        if (status >= 400) return [];
        const packs = (data as Record<string, unknown>).packs as Array<Record<string, unknown>> ?? [];
        return packs.map(p => ({
          id: p.id as string,
          version: p.version as string | undefined,
          isBuilt: p.isBuilt as boolean ?? false,
        }));
      },
      async createPack(packId: string, description?: string) {
        const body: Record<string, unknown> = { id: packId };
        if (description) body.description = description;
        const { status, data } = await apiCall(conn, "POST", "/api/packs/create", body, { timeoutMs: 30_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Failed to create pack (${status})`);
        return (data as Record<string, unknown>).packId as string ?? packId;
      },
      async packCleanImage(packId: string) {
        const { status, data } = await apiCall(conn, "DELETE", `/api/packs/${encodeURIComponent(packId)}/image`, undefined, { timeoutMs: 60_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Failed to clean image (${status})`);
        const d = data as Record<string, unknown>;
        return { imageRemoved: d.imageRemoved as boolean ?? false, tarRemoved: d.tarRemoved as boolean ?? false };
      },
      async removeContainers(instanceId: string) {
        const { status, data } = await apiCall(conn, "DELETE", `/api/instances/${encodeURIComponent(instanceId)}/team/containers`, undefined, { timeoutMs: 30_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Failed to remove containers (${status})`);
        return { removed: ((data as Record<string, unknown>).removed as string[]) ?? [] };
      },
      async teamSyncPreview() {
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(self.currentInstanceId)}/team/sync-preview`);
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Sync preview failed (${status})`);
        const d = data as Record<string, unknown>;
        return {
          packId: d.packId as string ?? "",
          currentVersion: d.currentVersion as string ?? "1.0.0",
          files: (d.files as Array<{ path: string; status: string }>) ?? [],
        };
      },
      async teamSyncExecute(message: string, bumpLevel?: "patch" | "minor" | "major") {
        const body: Record<string, unknown> = { message };
        if (bumpLevel) body.bump = bumpLevel;
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(self.currentInstanceId)}/team/sync`, body, { timeoutMs: 30_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Sync failed (${status})`);
        const d = data as Record<string, unknown>;
        return { version: typeof d.version === "string" ? d.version : "" };
      },
      async restartInstance(instanceId: string) {
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(instanceId)}/restart`, undefined, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Restart failed (${status})`);
      },
      async teamLoad(instanceId: string, packId: string, forkId?: string) {
        const body: Record<string, unknown> = { packId };
        if (forkId) body.forkId = forkId;
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(instanceId)}/team/load`, body, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Load pack failed (${status})`);
      },
      async fetchTeamInfo(instanceId: string) {
        const { status, data } = await apiCall(conn, "GET", `/api/instances/${encodeURIComponent(instanceId)}/team`);
        if (status >= 400) return { team: null, backups: [] };
        const d = data as Record<string, unknown>;
        return {
          team: (d.team as any) ?? null,
          backups: (d.backups as string[]) ?? [],
        };
      },
      async teamRestore(instanceId: string, backupName: string) {
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(instanceId)}/team/restore`, { backupName }, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Restore failed (${status})`);
      },
    };
  }

  /** Build the RendererCallbacks that fan emits/observes through this subscriber's WS. */
  private buildCallbacks(): RendererCallbacks {
    const self = this;
    const observers = this.observers;
    return {
      onUserInput(agentId, content, handoff, display) {
        return self.sendEmit({
          source: "user", type: "message",
          payload: { content, display },
          ts: Date.now(), to: agentId, handoff,
        });
      },
      onAgentCommand(agentId, toolName, cmdArgs) {
        // Best-effort — agent_command paths don't gate user-visible state on
        // delivery (the worker either has the agent or it doesn't). Log if
        // gateway returns ok:false; don't propagate.
        void self.sendEmit({
          source: "user", type: "agent_command",
          payload: { toolName, args: cmdArgs, agentId },
          ts: Date.now(),
        }).then((r) => {
          if (!r.ok) console.warn(`[subscriber] agent_command emit dropped: ${r.error}`);
        });
      },
      observeEvents(handler) {
        const h = (event: Record<string, unknown>, emitterId?: string) => {
          handler(event as Parameters<typeof handler>[0], emitterId);
        };
        observers.add(h);
        return () => { observers.delete(h); };
      },
      observeSnippets(handler) {
        self.snippetObservers.add(handler);
        return () => { self.snippetObservers.delete(handler); };
      },
      async listCommands(requestingAgentId?: string) {
        const result = await self.sendCommandRequest("list_commands", { requestingAgentId });
        if (!result.ok) return [];
        return result.data as CommandSpec[];
      },
      async commandQuery(name: string, args: string[], requestingAgentId?: string) {
        return self.sendCommandRequest("command_query", { name, args, requestingAgentId });
      },
      async commandExecute(name: string, args: string[], requestingAgentId?: string) {
        return self.sendCommandRequest("command_execute", { name, args, requestingAgentId });
      },
    };
  }

  /** Business init — wires up renderer / dataSource / callbacks. Runs every connect (incl. reconnect). */
  private async onReady(): Promise<void> {
    const dataSource = this.buildDataSource();
    const callbacks = this.buildCallbacks();

    this.renderer?.stop();
    this.observers.clear();

    clearScreen();
    setMediasDir(join(this.stateDir, "cache", "renderer", "medias"));

    const renderer = new InkRenderer(callbacks, dataSource);
    this.renderer = renderer;

    renderer.setSwitchInstanceCallback((newId: string) => {
      this.setInstanceId(newId);
    });

    renderer.setConnectionState(true);

    renderer.setInterruptCallback((agentId) => {
      const qs = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
      apiCall(this.conn, "POST", `/api/instances/${encodeURIComponent(this.currentInstanceId)}/interrupt${qs}`).catch(() => {});
    });

    renderer.setExitCallback(() => {
      this.stop().then(() => process.exit(0));
    });

    await renderer.start();

    process.on("SIGINT", () => {
      this.stop().then(() => process.exit(0));
    });
  }
}

/**
 * Resolve which instance the subscriber should connect to.
 *
 * Resolution order:
 *   1. explicit `cliArg`
 *   2. `MC_TARGET_INSTANCE` env var
 *   3. gateway-side `resolveInstanceId(conn)` (cache + heuristic)
 *   4. first instance from `listInstances(conn)` (with a printed note)
 *   5. empty string ("") — caller's fallback path
 *
 * Errors are swallowed so we always return *some* string; the connect step
 * itself will surface fatal connection problems with a clearer message.
 */
export async function resolveStartupInstanceId(opts: {
  stateDir: string;
  cliArg?: string;
}): Promise<string> {
  if (opts.cliArg) return opts.cliArg;
  const envId = process.env.MC_TARGET_INSTANCE;
  if (envId) return envId;
  try {
    const conn = loadConnInfo(opts.stateDir);
    const resolved = await resolveInstanceId(conn);
    if (resolved.instanceId !== null) {
      if (resolved.note) process.stdout.write(`${resolved.note}\n`);
      return resolved.instanceId;
    }
    const all = await listInstances(conn);
    if (all.length > 0) {
      const first = all[0]!.id;
      process.stdout.write(`所有实例均未就绪，连接到 "${first}"\n`);
      return first;
    }
  } catch { /* fallthrough to empty */ }
  return "";
}
