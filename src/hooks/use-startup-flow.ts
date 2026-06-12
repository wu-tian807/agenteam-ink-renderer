/**
 * useStartupFlow — startup navigation state machine (effects only).
 *
 * Drives: instance picker → agent picker → terminal setup prompt.
 * Does NOT own state — receives setters from the caller.
 */

import { useCallback, useRef, useEffect } from "react";
import type React from "react";
import type {
  RendererDataSource,
  CompletedTurn,
} from "../types.js";
import type { OverlaySchedulerResult } from "./use-overlay-scheduler.js";
import type { OverlayLayout } from "../types.js";
import { parseEventLines, trimToTurnBoundary, replayEvents } from "../lib/event-replay.js";
import { appendSystemTurn } from "../lib/system-message.js";
import {
  needsSetup,
  installKeybindings,
  setDismissed,
  getKeybindingsPath,
  isRemoteSsh,
  buildManualInstallInstructions,
} from "../lib/terminal-setup.js";

export interface StartupFlowResult {
  replaySession: (agentId: string) => Promise<void>;
  handleInstanceSwitch: (id: string) => void;
}

export function useStartupFlow(opts: {
  scheduler: OverlaySchedulerResult;
  dataSource: RendererDataSource;
  instanceId: string;
  activeAgent: string;
  showInstancePicker: () => void;
  showAgentPicker: (layout?: OverlayLayout) => void;
  showLoadPack: () => void;
  onSwitchInstance?: (id: string) => void;
  setActiveAgent: React.Dispatch<React.SetStateAction<string>>;
  setInstanceId: React.Dispatch<React.SetStateAction<string>>;
  setCompletedTurns: React.Dispatch<React.SetStateAction<CompletedTurn[]>>;
  setSessionLabel: React.Dispatch<React.SetStateAction<string>>;
  setContextPct: React.Dispatch<React.SetStateAction<number>>;
  scrollToBottom: () => void;
}): StartupFlowResult {
  const {
    scheduler, dataSource, instanceId, activeAgent,
    showInstancePicker, showAgentPicker, showLoadPack,
    onSwitchInstance, setActiveAgent, setInstanceId,
    setCompletedTurns, setSessionLabel, setContextPct,
    scrollToBottom,
  } = opts;

  const replaySession = useCallback(async (agentId: string) => {
    try {
      const raw = await dataSource.fetchAllEvents(agentId);
      if (!raw) return;
      const allParsed = await parseEventLines(raw);
      const events = trimToTurnBoundary(allParsed);
      const { turns, sessionId, contextPct: replayedPct } = await replayEvents(events, agentId);
      setCompletedTurns(turns);
      if (sessionId) setSessionLabel(sessionId);
      if (replayedPct > 0) setContextPct(replayedPct);
      queueMicrotask(() => scrollToBottom());
    } catch (err) { console.warn("[ink-renderer] replaySession failed:", err); }
  }, [dataSource, setCompletedTurns, setSessionLabel, setContextPct, scrollToBottom]);

  const handleInstanceSwitch = useCallback((id: string) => {
    setActiveAgent("");
    setCompletedTurns([]);
    setContextPct(0);
    setInstanceId(id);
    onSwitchInstance?.(id);
  }, [onSwitchInstance, setActiveAgent, setCompletedTurns, setContextPct, setInstanceId]);

  const overlayActive = scheduler.isActive();

  // Condition 1: no instance → show instance picker.
  useEffect(() => {
    if (instanceId || overlayActive) return;
    showInstancePicker();
  }, [instanceId, overlayActive]);

  // Condition 2: instance selected but no agent → resolve cached/default,
  // else either show the pack picker (no team on disk) or the agent picker.
  //
  // Why we look at hasTeam (not agents.length) to decide pack-vs-agent picker:
  //   `agents.length === 0` is what we *used* to gate the pack picker on, but
  //   that signal conflates two unrelated states — "instance has no pack" vs.
  //   "worker hasn't surfaced its agents yet". Worker-still-starting,
  //   provisioning-half-failed, or a transient IPC blip all return [] from
  //   listAgents() and used to mis-fire the pack picker over the user's
  //   screen, even when team/manifest.json was right there on disk. Past
  //   fixes (provision script paths, async git ops) made the happy path
  //   return non-empty faster, but the signal itself was still wrong.
  //   `hasTeam` is the static disk truth (`team/manifest.json` existence)
  //   surfaced by the gateway, orthogonal to worker lifecycle — the real
  //   answer to "should we ask the user to pick a pack?".
  useEffect(() => {
    if (!instanceId || activeAgent || overlayActive) return;

    (async () => {
      // Probe hasTeam first. If we can read it and it's false, the user
      // really has no pack loaded — show the picker. If listInstances is
      // unavailable (single-instance mode / older data source / network
      // hiccup), treat hasTeam as unknown and prefer NOT to interrupt with
      // a pack picker; fall through to the agents path so a transient
      // problem doesn't bury the user's screen under an overlay.
      let hasTeam: boolean | undefined;
      try {
        const instances = await dataSource.listInstances();
        hasTeam = instances.find(i => i.id === instanceId)?.hasTeam;
      } catch { /* hasTeam stays undefined → not stale, just unknown */ }

      if (hasTeam === false) {
        showLoadPack();
        return;
      }

      const agents = await dataSource.listAgents();
      if (agents.length === 0) {
        // hasTeam is true (or unknown) but the worker isn't reporting agents
        // yet. Don't pop the pack picker — that's the bug we just removed.
        // Show the agent picker; it self-polls and will populate as the
        // worker comes up. If the team really is broken, the user can pick
        // /load-pack from the slash menu.
        showAgentPicker("fullscreen");
        return;
      }

      const cached = dataSource.readCachedAgent(instanceId);
      if (cached && agents.includes(cached)) {
        setActiveAgent(cached);
        setCompletedTurns([]);
        replaySession(cached).catch(() => {});
        return;
      }

      const defaultAgent = await dataSource.fetchDefaultAgent();
      if (defaultAgent && agents.includes(defaultAgent)) {
        dataSource.writeCachedAgent(instanceId, defaultAgent).catch(() => {});
        setActiveAgent(defaultAgent);
        setCompletedTurns([]);
        replaySession(defaultAgent).catch(() => {});
        return;
      }

      showAgentPicker("fullscreen");
    })();
  }, [instanceId, activeAgent, overlayActive]);

  // Terminal setup prompt (Cursor/VSCode only, once per session)
  const terminalSetupShownRef = useRef(false);
  useEffect(() => {
    if (!activeAgent || overlayActive || terminalSetupShownRef.current) return;
    if (!needsSetup()) return;
    terminalSetupShownRef.current = true;

    const remote = isRemoteSsh();

    const pushSystemText = (text: string) => appendSystemTurn(setCompletedTurns, text, scrollToBottom);

    scheduler.push({
      id: "terminal-setup-prompt",
      kind: "select",
      layout: "modal",
      title: remote ? "终端快捷键需在本机安装" : "终端快捷键未配置",
      items: remote
        ? [
            { label: "查看本机安装说明", hint: "Shift+Enter 换行 / Ctrl+Enter Steer" },
            { label: "不再提示" },
          ]
        : [
            { label: "安装", hint: "启用 Shift+Enter 换行 / Ctrl+Enter Steer (推荐)" },
            { label: "跳过" },
            { label: "不再提示" },
          ],
      onConfirm: (idx) => {
        if (remote) {
          if (idx === 0) pushSystemText(buildManualInstallInstructions());
          else if (idx === 1) setDismissed(true);
          return;
        }
        if (idx === 0) {
          const result = installKeybindings();
          const lines: string[] = [];
          if (result.error) {
            lines.push(`❌ ${result.error}`);
          } else {
            if (result.installed.length > 0) {
              lines.push(`✅ 终端快捷键已安装: ${result.installed.join(", ")}`);
              lines.push(`   写入: ${getKeybindingsPath()}`);
            }
            lines.push("  Shift+Enter → 换行    Ctrl+Enter → Steer    /terminal-setup 管理");
          }
          pushSystemText(lines.join("\n"));
        } else if (idx === 2) {
          setDismissed(true);
        }
      },
    });
  }, [activeAgent, overlayActive]);

  return { replaySession, handleInstanceSwitch };
}
