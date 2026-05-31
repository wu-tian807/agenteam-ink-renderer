/**
 * useSlashCommands — maps slash-command strings to actions.
 *
 * Centralises the /agents, /instance, /tree, /board,
 * /terminal-setup routing so that app.tsx stays a pure orchestration
 * layer and doesn't grow a giant handleSlashCommand switch.
 *
 * Commands that open overlays go through the overlay scheduler;
 * unrecognised commands fall back to onUserInput.
 */

import React, { useCallback, useRef, useState } from "react";
import type { RendererCallbacks, RendererDataSource, CompletedTurn, StoredEvent } from "../types.js";
import type { OverlaySchedulerResult } from "./use-overlay-scheduler.js";
import type { OverlayLayout } from "../types.js";
import type { InputSegment } from "@agenteam/types";
import { segContent } from "@agenteam/types";
import { parseEventLines } from "../lib/event-replay.js";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import { panelListChromeOverhead } from "../lib/scrollable-list-viewport.js";
import { useScrollableListViewport } from "./use-scrollable-list-viewport.js";
import { ScrollableListFrame, scrollableListNavHint } from "../components/ScrollableListFrame.js";
import { BoardPanel } from "../components/BoardPanel.js";
import { parseCommand } from "@agenteam/types";
import { theme } from "../lib/theme.js";
import { appendSystemTurn } from "../lib/system-message.js";
import { resolveSlashCommand } from "../lib/slash-command-registry.js";
import type { CommandResult } from "@agenteam/types";
import {
  checkSetupStatus,
  installKeybindings,
  uninstallKeybindings,
  isNativeExtendedKeyTerminal,
  setDismissed,
  getKeybindingsPath,
  isRemoteSsh,
  buildManualInstallInstructions,
} from "../lib/terminal-setup.js";

interface UseSlashCommandsDeps {
  scheduler: OverlaySchedulerResult;
  callbacks: RendererCallbacks;
  dataSource: RendererDataSource;
  activeAgentRef: React.RefObject<string>;
  instanceId: string;
  showAgentPicker: (layout?: OverlayLayout) => void;
  showInstancePicker: () => void;
  showDeleteCurrentAgent: () => void;
  showDeleteInstancePicker: () => void;
  showPackCleanImage: () => void;
  showRemoveContainers: () => void;
  showSyncPack: () => void;
  showLoadPack: () => void;
  showTeamRestore: () => void;
  setCompletedTurns: React.Dispatch<React.SetStateAction<CompletedTurn[]>>;
  replaySession: (agentId: string) => Promise<void>;
  scrollToBottom: () => void;
  /** Restore segments into the input box (e.g. after /rewind, mirrors Ctrl+C). */
  restoreInput?: (segments: InputSegment[]) => void;
}

type SaveTarget = "overrides" | "agent_json";

interface ModelChainPanelProps {
  models: string[];
  initialChain: string[];
  onSave: (target: SaveTarget, chain: string[]) => Promise<void>;
  onSaved: (target: SaveTarget, chain: string[]) => void;
  onError: (target: SaveTarget, err: unknown) => void;
}

const BUTTONS: ReadonlyArray<{ target: SaveTarget; label: string }> = [
  { target: "agent_json", label: "写入 agent.json（基础配置，pack 升级会被覆盖）" },
  { target: "overrides",  label: "写入 agent-overrides.json（用户覆盖层，推荐）" },
];

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of list) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

// ── /rewind picker helpers ──

/** Plain-text preview of a user message event for the rewind list row. */
function rewindEventText(ev: StoredEvent): string {
  const payload = ev.payload as
    | { content?: unknown; display?: { segments?: InputSegment[] } }
    | undefined;
  let text = typeof payload?.content === "string" ? payload.content : "";
  if (!text && Array.isArray(payload?.display?.segments)) {
    text = segContent(payload!.display!.segments!);
  }
  return text.replace(/\s+/g, " ").trim();
}

function truncatePreview(text: string, max = 60): string {
  if (!text) return "((空消息))";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Compact relative time like "3分钟前" for the rewind list hint. */
function formatRelativeTimeAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.round(hr / 24);
  return `${day}天前`;
}

function ModelChainPanel({ models, initialChain, onSave, onSaved, onError }: ModelChainPanelProps): React.JSX.Element {
  const [chain, setChain] = useState(() => dedupe(initialChain));
  const [idx, setIdx] = useState(0);
  const [saving, setSaving] = useState<SaveTarget | null>(null);
  const { slice, rowBudget } = useScrollableListViewport();

  // Catalog order, with any unknown models still in chain appended so user can
  // explicitly remove them. SAVE buttons live OUTSIDE the scrollable list so
  // they're always visible at the bottom; the cursor index spans both spaces.
  const unknownSelected = chain.filter((m) => !models.includes(m));
  const listItems = [...models, ...unknownSelected];
  const totalIdx = listItems.length + BUTTONS.length;
  const safeIdx = Math.min(Math.max(0, idx), totalIdx - 1);
  const cursorOnButtonAt = safeIdx >= listItems.length ? safeIdx - listItems.length : -1;

  const viewport = slice({
    itemCount: listItems.length,
    cursorIndex: safeIdx,
    rowBudget: rowBudget("fullscreen"),
    chromeOverhead: panelListChromeOverhead(BUTTONS.length),
    freezeFollow: cursorOnButtonAt >= 0,
  });
  const { start, end, needsScroll } = viewport;

  useInput((_input, key) => {
    if (saving) return;
    if (key.upArrow) setIdx(cur => Math.max(0, cur - 1));
    else if (key.downArrow) setIdx(cur => Math.min(totalIdx - 1, cur + 1));
    else if (key.return) {
      if (cursorOnButtonAt >= 0) {
        if (chain.length === 0) return;
        const target = BUTTONS[cursorOnButtonAt]!.target;
        setSaving(target);
        onSave(target, chain).then(
          () => onSaved(target, chain),
          (err) => {
            setSaving(null);
            onError(target, err);
          },
        );
        return;
      }
      const item = listItems[safeIdx];
      if (!item) return;
      setChain(cur => cur.includes(item) ? cur.filter((m) => m !== item) : [...cur, item]);
    }
  });

  const visibleSlice = listItems.slice(start, end);

  return (
    <Box flexDirection="column">
      <ScrollableListFrame slice={viewport}>
      {visibleSlice.map((item, viewportIdx) => {
        const i = start + viewportIdx;
        const selected = cursorOnButtonAt < 0 && i === safeIdx;
        const cursor = (
          <Text color={selected ? theme.overlay.selectedColor : undefined}>
            {selected ? `${theme.overlay.selectedChar} ` : "  "}
          </Text>
        );
        const priority = chain.indexOf(item) + 1;
        return (
          <Box key={item}>
            {cursor}
            {priority > 0 ? (
              <Text color="black" backgroundColor="green" bold> {priority} </Text>
            ) : (
              <Text dimColor>○</Text>
            )}
            <Text bold={selected}> {item}</Text>
            {!models.includes(item) ? <Text dimColor> (不在 models.json)</Text> : null}
          </Box>
        );
      })}
      </ScrollableListFrame>
      <Box marginTop={1} flexDirection="column">
        {BUTTONS.map((btn, i) => {
          const selected = cursorOnButtonAt === i;
          const isSavingThis = saving === btn.target;
          const empty = chain.length === 0;
          return (
            <Box key={btn.target}>
              <Text color={selected ? theme.overlay.selectedColor : undefined}>
                {selected ? `${theme.overlay.selectedChar} ` : "  "}
              </Text>
              <Text bold={selected} dimColor={empty || (saving !== null && !isSavingThis)}>
                {isSavingThis ? "写入中... " : ""}
                {btn.label}
                {empty ? "  (请先勾选至少一个模型)" : ""}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box>
        <Text dimColor>
          {saving
            ? "写入中..."
            : scrollableListNavHint(needsScroll, safeIdx + 1, totalIdx, "Enter 勾选/确认  Esc 关闭")}
        </Text>
      </Box>
    </Box>
  );
}

export function useSlashCommands({
  scheduler,
  callbacks,
  dataSource,
  activeAgentRef,
  instanceId,
  showAgentPicker,
  showInstancePicker,
  showDeleteCurrentAgent,
  showDeleteInstancePicker,
  showPackCleanImage,
  showRemoveContainers,
  showSyncPack,
  showLoadPack,
  showTeamRestore,
  setCompletedTurns,
  replaySession,
  scrollToBottom,
  restoreInput,
}: UseSlashCommandsDeps): (command: string) => void {

  const pushSystemMessage = useCallback((text: string) => {
    appendSystemTurn(setCompletedTurns, text, scrollToBottom);
  }, [setCompletedTurns, scrollToBottom]);

  const handleModelPicker = useCallback(() => {
    const agentId = activeAgentRef.current;
    if (!agentId) {
      pushSystemMessage("没有选中 agent，请先 /agents 选择一个。");
      return;
    }
    // Reads stay on dataSource (query channel); writes are dispatched via the
    // command system so the backend `models` module owns file I/O + validation.
    if (!dataSource.listAvailableModels || !dataSource.readAgentOverrides) {
      pushSystemMessage("当前 dataSource 不支持 /model（需要 Gateway 通道）。");
      return;
    }
    if (!callbacks.commandExecute) {
      pushSystemMessage("当前 callbacks 不支持 commandExecute（需要 worker 命令通道）。");
      return;
    }

    const normalizeModelChain = (m: unknown): string[] => {
      if (Array.isArray(m)) {
        return m.filter((x) => x && String(x) !== "null").map(String);
      }
      if (typeof m === "string" && m && m !== "null") return [m];
      return [];
    };

    const formatModelChain = (models: string[]): string => models.join(" -> ");

    const TARGET_META: Record<SaveTarget, { command: string; file: string; label: string }> = {
      overrides:  { command: "models_set_in_overrides",  file: `team/homes/${agentId}/agent-overrides.json`, label: "agent-overrides.json" },
      agent_json: { command: "models_set_in_agent_json", file: `team/agents/${agentId}/agent.json`,          label: "agent.json" },
    };

    const showChainPicker = (models: string[], chain: string[]) => {
      scheduler.push({
        id: "model-picker",
        kind: "panel",
        layout: "fullscreen",
        title: `编排模型 fallback chain (${agentId})`,
        render: (close) => (
          <ModelChainPanel
            models={models}
            initialChain={chain}
            onSave={async (target, nextChain) => {
              const value: string | string[] = nextChain.length === 1 ? nextChain[0]! : nextChain;
              const r = await callbacks.commandExecute!(TARGET_META[target].command, [agentId, JSON.stringify(value)], agentId);
              if (!r.ok) throw new Error(r.error ?? `Failed to ${TARGET_META[target].command}`);
            }}
            onSaved={(target, nextChain) => {
              close();
              const meta = TARGET_META[target];
              pushSystemMessage(`✅ 已切换 ${agentId} 的模型链路为 ${formatModelChain(nextChain)}\n   写入 ${meta.file}，agent 会自动热加载。`);
            }}
            onError={(target, err) => {
              const meta = TARGET_META[target];
              pushSystemMessage(`❌ 写入 ${meta.label} 失败: ${(err as Error)?.message ?? String(err)}`);
            }}
          />
        ),
      });
    };

    Promise.all([
      dataSource.listAvailableModels!(),
      dataSource.readAgentOverrides!(agentId),
      dataSource.fetchAgentJson?.(agentId) ?? Promise.resolve(null),
    ]).then(([models, overrides, agentJson]) => {
      if (models.length === 0) {
        pushSystemMessage("当前 models.json 为空，请先在 Gateway 注册模型。");
        return;
      }

      // 编辑缓冲：override 优先，否则把 agent.json 的 model 复制过来作为起点。
      const overrideModel = (overrides.models as Record<string, unknown> | undefined)?.model;
      const agentModel = (agentJson?.models as Record<string, unknown> | undefined)?.model;
      const overrideChain = normalizeModelChain(overrideModel);
      const agentChain = normalizeModelChain(agentModel);
      const initialChain = overrideChain.length > 0 ? overrideChain : agentChain;
      showChainPicker(models, initialChain);
    }).catch((err) => {
      pushSystemMessage(`❌ 读取模型配置失败: ${err?.message ?? String(err)}`);
    });
  }, [scheduler, dataSource, callbacks, activeAgentRef, pushSystemMessage]);

  const handleTerminalSetup = useCallback(() => {
    const termProgram = process.env.TERM_PROGRAM;
    const isVscode = termProgram === "vscode";

    if (!isVscode) {
      const isNative = isNativeExtendedKeyTerminal();
      const lines = isNative
        ? [
            `当前终端 (${termProgram}) 原生支持扩展键序列，无需配置。`,
            "",
            "快捷键：",
            "  Shift+Enter → 换行    Ctrl+Enter → Steer    Ctrl+\\ → Steer (备用)",
          ]
        : [
            `当前终端: ${termProgram ?? "unknown"}`,
            "",
            "快捷键：",
            "  \\+Enter → 换行    Ctrl+\\ → Steer",
            "",
            "Shift+Enter 需要终端支持 Kitty 键盘协议。",
            "支持的终端: Ghostty, Kitty, iTerm2, WezTerm, Warp",
          ];
      pushSystemMessage(lines.join("\n"));
      return;
    }

    if (isRemoteSsh()) {
      scheduler.push({
        id: "terminal-setup",
        kind: "select",
        layout: "modal",
        title: "终端快捷键 (Remote SSH)",
        items: [
          { label: "查看本机安装说明" },
          { label: "不再提示本次启动弹窗", hint: "仅控制启动自动弹出" },
        ],
        onConfirm: (idx) => {
          if (idx === 0) pushSystemMessage(buildManualInstallInstructions());
          else if (idx === 1) setDismissed(true);
        },
      });
      return;
    }

    const status = checkSetupStatus();

    const items = status.allInstalled
      ? [
          { label: "卸载快捷键", hint: "移除 shift+enter / ctrl+enter 绑定" },
          { label: "查看状态" },
        ]
      : [
          { label: "安装快捷键", hint: "推荐 — 启用 Shift+Enter 换行 / Ctrl+Enter Steer" },
          { label: "查看状态" },
          ...(status.shiftEnterInstalled || status.ctrlEnterInstalled
            ? [{ label: "卸载快捷键", hint: "移除已安装的绑定" }]
            : []),
        ];

    scheduler.push({
      id: "terminal-setup",
      kind: "select",
      layout: "modal",
      title: "终端快捷键配置",
      items,
      onConfirm: (idx) => {
        const chosen = items[idx]!.label;

        if (chosen === "安装快捷键") {
          const result = installKeybindings();
          if (result.error) {
            pushSystemMessage(`❌ ${result.error}`);
          } else {
            const lines = ["终端快捷键配置"];
            if (result.installed.length > 0) {
              lines.push(`✅ 已安装: ${result.installed.join(", ")}`);
              lines.push(`   写入: ${getKeybindingsPath()}`);
            }
            if (result.skipped.length > 0) {
              lines.push(`⏭  已存在: ${result.skipped.join(", ")}`);
            }
            lines.push("", "快捷键：");
            lines.push("  Shift+Enter → 换行    Ctrl+Enter → Steer    Ctrl+\\ → Steer (备用)");
            pushSystemMessage(lines.join("\n"));
            setDismissed(false);
          }
        } else if (chosen === "卸载快捷键") {
          const result = uninstallKeybindings();
          if (result.error) {
            pushSystemMessage(`❌ ${result.error}`);
          } else {
            const lines = ["终端快捷键配置"];
            if (result.installed.length > 0) {
              lines.push(`🗑  已卸载: ${result.installed.join(", ")}`);
              lines.push(`   更新: ${getKeybindingsPath()}`);
            }
            if (result.skipped.length > 0) {
              lines.push(`⏭  未找到: ${result.skipped.join(", ")}`);
            }
            lines.push("", "备用方式仍可用：\\+Enter 换行，Ctrl+\\ Steer");
            pushSystemMessage(lines.join("\n"));
          }
        } else if (chosen === "查看状态") {
          const s = checkSetupStatus();
          const lines = [
            "终端快捷键状态",
            `  配置文件: ${s.kbPath ?? "未找到"}`,
            `  shift+enter: ${s.shiftEnterInstalled ? "✅ 已安装" : "❌ 未安装"}`,
            `  ctrl+enter:  ${s.ctrlEnterInstalled ? "✅ 已安装" : "❌ 未安装"}`,
          ];
          pushSystemMessage(lines.join("\n"));
        }
      },
    });
  }, [scheduler, pushSystemMessage]);

  // /rewind — pick a historical user message and fork the session at that
  // point (drops it + everything after, switches to the new branch, and
  // restores the message text into the input box so the user can edit &
  // resubmit). Mirrors the Ctrl+C auto-undo path in app.tsx, but lets the
  // user choose ANY past message rather than only the most recent one.
  //
  // Data flow:
  //   fetch_session_events (raw JSONL, tail since last compact)
  //     → parse → keep user message events (type:"message", source:"user")
  //     → select overlay (most recent first, default-selected)
  //     → commandExecute("rewind", [agentId, String(ev.ts)])
  //     → clear turns + replaySession + restore input segments
  const handleRewindPicker = useCallback(() => {
    const agentId = activeAgentRef.current;
    if (!agentId) {
      pushSystemMessage("没有选中 agent，请先 /agents 选择一个。");
      return;
    }
    if (!callbacks.commandQuery || !callbacks.commandExecute) {
      pushSystemMessage("当前 callbacks 不支持 command 通道。");
      return;
    }

    // Captured by loadItems and read in onConfirm — maps the selected list
    // index back to the concrete event (we fork by its `ts`).
    let userEvents: StoredEvent[] = [];

    scheduler.push({
      id: "rewind-picker",
      kind: "select",
      // Fullscreen, not modal: a modal select shares the bottom-50% box with
      // StatusLayer + InputBox, but its viewport budget (floor(rows/2)) counts
      // the *whole* bottom half — so a long user-message list over-renders and
      // Yoga clips the lower rows ("options vanish while scrolling"). Every
      // other multi-item picker (agents/instance/pack/restore) is fullscreen
      // for exactly this reason; the rewind list can be long too.
      layout: "fullscreen",
      title: `回退对话 (${agentId}) — 选择回到哪条消息之前`,
      loadItems: async () => {
        const r = await callbacks.commandQuery!("fetch_session_events", [agentId], agentId);
        if (!r.ok) throw new Error(r.error);
        const raw = typeof r.data === "string" ? r.data : "";
        const events = parseEventLines(raw);
        // Most recent first so "undo my last message" is the default (top) row.
        // New-standard user messages only: `type: "message"` + `source: "user"`
        // (excludes agent-sourced messages and user-sourced agent_command).
        userEvents = events
          .filter((e) => e.type === "message" && e.source === "user")
          .reverse();
        const now = Date.now();
        return userEvents.map((ev) => ({
          label: truncatePreview(rewindEventText(ev)),
          hint: formatRelativeTimeAgo(ev.ts, now),
          hintColor: theme.overlay.disabledColor,
        }));
      },
      onConfirm: (idx) => {
        const ev = userEvents[idx];
        if (!ev) return;
        void callbacks.commandExecute!(
          "rewind",
          [agentId, String(ev.ts)],
          agentId,
        ).then((r2) => {
          if (!r2.ok) {
            pushSystemMessage(`❌ 回退失败: ${r2.error}`);
            return;
          }
          const data = r2.data as {
            atEvent?: { payload?: { display?: { segments?: InputSegment[] } } };
          } | undefined;

          // Clear first so the UI doesn't briefly show the old tail while the
          // replay of the freshly-forked session is in flight.
          setCompletedTurns([]);
          replaySession(agentId).catch(() => {});

          // Restore the rewound message text into the input box for editing.
          const segs = data?.atEvent?.payload?.display?.segments;
          if (Array.isArray(segs) && segs.length > 0) {
            restoreInput?.(segs);
          }

          pushSystemMessage(
            `✅ 已回退到「${truncatePreview(rewindEventText(ev), 40)}」之前，并切换到新分支。`,
          );
        });
      },
    });
  }, [scheduler, callbacks, activeAgentRef, pushSystemMessage, setCompletedTurns, replaySession, restoreInput]);

  // Render a worker command result as a system message. Panels that need
  // structured rendering should add their own panel component and call
  // callbacks.commandQuery/commandExecute directly.
  //
  // Success-with-dispatched (e.g. /compact, /skill-{name}) intentionally
  // produces no UI line — the dispatched tool will surface its own output
  // on the next turn. Errors always surface so failures aren't swallowed.
  const pushCommandResult = useCallback((name: string, result: CommandResult): void => {
    if (!result.ok) {
      pushSystemMessage(`[/${name}] ❌ ${result.error}`);
      return;
    }
    const data = result.data;
    if (data && typeof data === "object" && (data as Record<string, unknown>).dispatched === true) {
      return;
    }
    const repr = data == null ? "(no data)"
      : typeof data === "string" ? data
      : typeof data === "number" || typeof data === "boolean" ? String(data)
      : JSON.stringify(data, null, 2);
    pushSystemMessage(`[/${name}]\n${repr}`);
  }, [pushSystemMessage]);

  // Phase 1.1: fall back to the legacy agent_command (LLM tool_call) path.
  const fallbackToAgentCommand = useCallback((command: string): void => {
    const parsed = parseCommand(command);
    if (parsed) {
      const targetAgent = parsed.target === "/" ? activeAgentRef.current : parsed.target;
      callbacks.onAgentCommand(targetAgent, parsed.toolName, parsed.args);
    } else {
      callbacks.onUserInput(activeAgentRef.current, command, "turn");
    }
  }, [callbacks, activeAgentRef]);

  const handleSlashCommand = useCallback((command: string) => {
    const spec = resolveSlashCommand(command);

    switch (spec?.handler) {
      case "agents":
        showAgentPicker("fullscreen");
        return;
      case "model":
        handleModelPicker();
        return;
      case "instance":
        showInstancePicker();
        return;
      case "delete-agent":
        showDeleteCurrentAgent();
        return;
      case "delete-instance":
        showDeleteInstancePicker();
        return;
      case "clean-image":
        showPackCleanImage();
        return;
      case "rm-containers":
        showRemoveContainers();
        return;
      case "sync-pack":
        showSyncPack();
        return;
      case "load-pack":
        showLoadPack();
        return;
      case "restore":
        showTeamRestore();
        return;
      case "terminal-setup":
        handleTerminalSetup();
        return;
      case "board":
        scheduler.push({
          id: "board-panel",
          kind: "panel",
          layout: "fullscreen",
          title: `Board: ${activeAgentRef.current}`,
          render: (_close) => <BoardPanel agentId={activeAgentRef.current} />,
        });
        return;
      case "restart-instance": {
        // restartInstance lives on RendererDataSource (Gateway HTTP), NOT on
        // RendererCallbacks — reading from `callbacks` here was a wiring bug:
        // the property is permanently undefined on the callbacks object and the
        // guard short-circuited to the "dataSource 不支持" message.
        if (!dataSource.restartInstance) {
          pushSystemMessage("当前 dataSource 不支持 /restart_instance（需要 Gateway 通道）。");
          return;
        }
        if (!instanceId) {
          pushSystemMessage("还未选中 Instance，请先 /instance 选择一个。");
          return;
        }
        pushSystemMessage("⟳ 重启 Instance 中...");
        void dataSource.restartInstance(instanceId).then(
          () => pushSystemMessage("✓ Instance 已重启。"),
          (err: Error) => pushSystemMessage(`❌ 重启失败: ${err?.message ?? String(err)}`),
        );
        return;
      }
      case "session": {
        const agentId = activeAgentRef.current;
        if (!agentId) {
          pushSystemMessage("没有选中 agent，请先 /agents 选择一个。");
          return;
        }
        if (!callbacks.commandQuery || !callbacks.commandExecute) {
          pushSystemMessage("当前 callbacks 不支持 command 通道。");
          return;
        }
        void callbacks.commandQuery("list_sessions", [agentId], agentId).then((r) => {
          if (!r.ok) {
            pushSystemMessage(`❌ 获取 session 列表失败: ${r.error}`);
            return;
          }
          const data = r.data as { sessions?: string[] };
          const sessions = data?.sessions ?? [];
          const items = [
            ...sessions.map(s => ({ label: s })),
            { label: "＋ 新建 Session", hint: "创建空白 session" },
          ];
          scheduler.push({
            id: "session-picker",
            kind: "select",
            // Fullscreen for the same reason as the rewind picker: a modal
            // select's viewport budget (floor(rows/2)) over-counts the shared
            // bottom-half box (status + input), clipping a long session list.
            layout: "fullscreen",
            title: `切换 Session (${agentId})`,
            items,
            onConfirm: (idx) => {
              const isNew = idx === sessions.length;
              const sessionArg = isNew ? "new" : sessions[idx]!;
              void callbacks.commandExecute!("switch-session", [agentId, sessionArg], agentId).then((r2) => {
                if (!r2.ok) {
                  pushSystemMessage(`❌ 切换失败: ${r2.error}`);
                  return;
                }
                const result = r2.data as { sessionId?: string; created?: boolean };
                pushSystemMessage(
                  result?.created
                    ? `✅ 已创建并切换到新 Session: ${result.sessionId}`
                    : `✅ 已切换到 Session: ${result?.sessionId ?? sessionArg}`,
                );
                // Reload history from the new session
                setCompletedTurns([]);
                replaySession(agentId).catch(() => {});
              });
            },
          });
        });
        return;
      }
      case "rewind":
        handleRewindPicker();
        return;
      case "agent-command":
      case undefined: {
        // Phase 1.1: worker-command fallback. If the slash command isn't in
        // SLASH_COMMANDS (spec === null) AND the subscriber supports the
        // command system, try worker query/execute first. Only fall back to
        // agent_command if worker says "Unknown command".
        if (spec === null && callbacks.commandQuery && callbacks.commandExecute) {
          const trimmed = command.replace(/^\/+/, "").trim();
          const [cmdName, ...argTokens] = trimmed.split(/\s+/);
          if (cmdName) {
            const args: string[] = argTokens;  // positional; worker module owns parsing
            const activeId = activeAgentRef.current;
            void (async () => {
              const r = await callbacks.commandQuery!(cmdName, args, activeId);
              if (r.ok) { pushCommandResult(cmdName, r); return; }
              if (r.error.includes("has no query") || r.error.includes("No query for")) {
                const r2 = await callbacks.commandExecute!(cmdName, args, activeId);
                pushCommandResult(cmdName, r2);
                return;
              }
              if (!r.error.startsWith("Unknown command")) {
                pushCommandResult(cmdName, r);
                return;
              }
              // True unknown → legacy agent_command fallback
              fallbackToAgentCommand(command);
            })();
            return;
          }
        }
        fallbackToAgentCommand(command);
      }
    }
  }, [
    callbacks, dataSource, scheduler, activeAgentRef, instanceId,
    showAgentPicker, showInstancePicker, showDeleteCurrentAgent,
    showDeleteInstancePicker, showPackCleanImage, showRemoveContainers, showSyncPack,
    showLoadPack, showTeamRestore, handleTerminalSetup, handleModelPicker,
    handleRewindPicker,
  ]);

  return handleSlashCommand;
}
