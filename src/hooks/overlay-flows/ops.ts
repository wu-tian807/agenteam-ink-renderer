/**
 * @desc Operational overlay flows — pack clean-image, rm-containers, sync-pack.
 */

import React from "react";
import type { OverlayFlowDeps } from "./types.js";
import { C } from "../../lib/colors.js";
import { makeInstanceLoadItems, pushConfirm } from "./helpers.js";
import { TextInputPanel } from "../../components/TextInputPanel.js";

// ── Pack clean-image (select pack → confirm) ──

export function showPackCleanImage({ scheduler, dataSource, pushSystemMessage }: OverlayFlowDeps): void {
  scheduler.push({
    id: "pack-clean-image-picker",
    kind: "select",
    layout: "fullscreen",
    title: "选择要清理镜像的 Pack",
    loadItems: async () => {
      const packs = await dataSource.listPacks();
      return packs.map(p => ({
        label: p.id,
        hint: `${p.version ? `v${p.version}` : ""} ${p.isBuilt ? "[已构建]" : "[未构建]"}`.trim(),
        hintColor: p.isBuilt ? C.green : C.blackBright,
      }));
    },
    onConfirm: (_idx, item) => {
      const packId = item.label;
      pushConfirm(scheduler, {
        id: "pack-clean-image-confirm",
        title: `确认删除 Pack "${packId}" 的镜像？`,
        confirmLabel: "确认删除镜像（可重新构建）",
        onConfirm: () => {
          scheduler.clear();
          dataSource.packCleanImage(packId)
            .then(r => pushSystemMessage(
              `🗑  Pack "${packId}" 镜像已清理` +
              `\n  Docker 镜像: ${r.imageRemoved ? "已删除" : "未找到"}` +
              `\n  image.tar: ${r.tarRemoved ? "已删除" : "未找到"}`,
            ))
            .catch(e => pushSystemMessage(`❌ 清理失败: ${e instanceof Error ? e.message : String(e)}`));
        },
      });
    },
  });
}

// ── Remove all containers (select instance → confirm) ──

export function showRemoveContainers(deps: OverlayFlowDeps): void {
  const { scheduler, dataSource, pushSystemMessage } = deps;
  scheduler.push({
    id: "rm-containers-picker",
    kind: "select",
    layout: "fullscreen",
    title: "选择要删除容器的 Instance",
    loadItems: makeInstanceLoadItems(dataSource),
    onConfirm: (_idx, item) => {
      const targetId = item.label;
      pushConfirm(scheduler, {
        id: "rm-containers-confirm",
        title: `确认删除 Instance "${targetId}" 的全部容器？`,
        confirmLabel: "确认删除全部容器",
        onConfirm: () => {
          scheduler.clear();
          dataSource.removeContainers(targetId)
            .then(r => {
              const msg = r.removed.length > 0
                ? `🗑  已删除 ${r.removed.length} 个容器: ${r.removed.join(", ")}`
                : `ℹ  Instance "${targetId}" 无容器需要清理`;
              pushSystemMessage(msg);
            })
            .catch(e => pushSystemMessage(`❌ 删除容器失败: ${e instanceof Error ? e.message : String(e)}`));
        },
      });
    },
  });
}

// ── Sync team → pack (auto-patch from tag distance; minor/major tag explicitly) ──

const SYNC_PRESETS = [
  { label: "patch  (auto from tag distance)", bump: "patch" as const, message: "chore: sync" },
  { label: "minor  (tag vX.Y+1.0 then commit)", bump: "minor" as const, message: "feat: sync" },
  { label: "major  (tag vX+1.0.0 then commit)", bump: "major" as const, message: "BREAKING: sync" },
] as const;
const CUSTOM_LABEL = "自定义 commit message... (patch)";
const CANCEL_LABEL = "取消";

export function showSyncPack({ scheduler, dataSource, pushSystemMessage }: OverlayFlowDeps): void {
  function executeSync(message: string, bump?: "patch" | "minor" | "major"): void {
    (async () => {
      try {
        const preview = await dataSource.teamSyncPreview();
        const result = await dataSource.teamSyncExecute(message, bump);
        const summary = preview.files.length > 0
          ? preview.files.map(f => `  ${f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~"} ${f.path}`).join("\n")
          : "  (无文件变更)";
        pushSystemMessage(
          `✅ 已同步到 Pack "${preview.packId}" v${result.version}` +
          `\n  bump: ${bump ?? "patch (auto)"}  message: ${message}` +
          `\n${summary}`,
        );
      } catch (e) {
        pushSystemMessage(`❌ 同步失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  scheduler.push({
    id: "sync-pack-preview",
    kind: "select",
    layout: "fullscreen",
    title: "同步 Team → Pack（patch 自动算 tag 距离；minor/major 显式 tag）",
    loadItems: async () => {
      const preview = await dataSource.teamSyncPreview();
      const fileHint = preview.files.length > 0
        ? `${preview.files.length} 个文件变更`
        : "无文件变更";
      const baseHint = `${preview.packId} v${preview.currentVersion} · ${fileHint}`;
      return [
        ...SYNC_PRESETS.map(p => ({ label: p.label, hint: baseHint })),
        { label: CUSTOM_LABEL, hint: "弹输入框收 commit message；bump 默认 patch（自动）" },
        { label: CANCEL_LABEL },
      ];
    },
    onConfirm: (idx, item) => {
      if (item.label === CANCEL_LABEL) return;
      if (item.label === CUSTOM_LABEL) {
        scheduler.push({
          id: "sync-pack-custom-msg",
          kind: "panel",
          layout: "fullscreen",
          title: "输入 commit message (patch bump auto)",
          render: () =>
            React.createElement(TextInputPanel, {
              prompt: "Commit message (e.g. 'fix: tighten X'):",
              validate: (v: string) => v.trim() ? null : "commit message 不能为空",
              onSubmit: (msg: string) => {
                scheduler.clear();
                executeSync(msg.trim());  // bump omitted → server auto-patch
              },
            }),
        });
        return;
      }
      const preset = SYNC_PRESETS[idx];
      if (!preset) return;
      scheduler.clear();
      executeSync(preset.message, preset.bump);
    },
  });
}
