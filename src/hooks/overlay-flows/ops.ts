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

// ── Sync team → pack: ① commit message (always) → ② bump level (defaults patch) ──

const BUMP_LEVELS = [
  { label: "patch  (auto from tag distance)",  bump: "patch" as const, hint: "默认；累计提交数自动 +N" },
  { label: "minor  (tag vX.Y+1.0 then commit)", bump: "minor" as const, hint: "新功能" },
  { label: "major  (tag vX+1.0.0 then commit)", bump: "major" as const, hint: "破坏性变更" },
] as const;

export function showSyncPack({ scheduler, dataSource, pushSystemMessage }: OverlayFlowDeps): void {
  function runSync(message: string, bump: "patch" | "minor" | "major"): void {
    (async () => {
      try {
        const preview = await dataSource.teamSyncPreview();
        const result = await dataSource.teamSyncExecute(message, bump);
        const summary = preview.files.length > 0
          ? preview.files.map(f => `  ${f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~"} ${f.path}`).join("\n")
          : "  (无文件变更)";
        pushSystemMessage(
          `✅ 已同步到 Pack "${preview.packId}" v${result.version}` +
          `\n  bump: ${bump}  message: ${message}` +
          `\n${summary}`,
        );
      } catch (e) {
        pushSystemMessage(`❌ 同步失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  // Step 1: collect commit message (always required).
  scheduler.push({
    id: "sync-pack-message",
    kind: "panel",
    layout: "fullscreen",
    title: "同步 Team → Pack ① 输入 commit message",
    render: () =>
      React.createElement(TextInputPanel, {
        prompt: "Commit message (e.g. 'fix: tighten X'):",
        validate: (v: string) => v.trim() ? null : "commit message 不能为空",
        onSubmit: (msg: string) => {
          const trimmed = msg.trim();
          // Step 2: pick bump level (patch default, minor / major optional).
          scheduler.push({
            id: "sync-pack-bump",
            kind: "select",
            layout: "fullscreen",
            title: `同步 Team → Pack ② 选择 bump 级别 — "${trimmed}"`,
            items: [
              ...BUMP_LEVELS.map(b => ({ label: b.label, hint: b.hint })),
              { label: "取消" },
            ],
            onConfirm: (idx) => {
              scheduler.clear();
              const level = BUMP_LEVELS[idx];
              if (!level) return;  // 取消 or out-of-range
              runSync(trimmed, level.bump);
            },
          });
        },
      }),
  });
}
