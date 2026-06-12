/**
 * @desc Instance lifecycle overlay flows — create, delete, load pack, restore backup.
 */

import React from "react";
import type { OverlayFlowDeps } from "./types.js";
import type { InstanceStatus } from "@agenteam/types";
import { isInstanceSelectable } from "@agenteam/types";
import { C } from "../../lib/colors.js";
import { CreateInstancePanel } from "../../components/CreateInstancePanel.js";
import { TextInputPanel } from "../../components/TextInputPanel.js";
import { makeInstanceLoadItems, buildInstanceItems, pushConfirm } from "./helpers.js";

const ACTION_CREATE = "➕ 新建 Instance";
const ACTION_DELETE = "✗  删除 Instance";

// Stable, user-actionable states that get an Enter hint in the picker. For
// `idle` we further inspect `InstanceInfo.hasTeam` to route Enter to either
// restart (hasTeam=true) or the pack picker (hasTeam=false). `error` always
// routes to restart (the previous failure reason rides along in
// statusMessage).
const RESTARTABLE_STATUSES: ReadonlySet<string> = new Set<InstanceStatus>(["error", "idle"]);

function selectable(i: { status: string }): boolean {
  return isInstanceSelectable({ status: i.status as InstanceStatus });
}

// ── Create instance ──

export function showCreateInstance({ scheduler, dataSource, pushSystemMessage }: OverlayFlowDeps): void {
  scheduler.push({
    id: "create-instance",
    kind: "panel",
    layout: "fullscreen",
    title: "创建 Instance",
    render: (close) =>
      React.createElement(CreateInstancePanel, {
        dataSource,
        close,
        onCreated: (id: string) => pushSystemMessage(`✅ Instance "${id}" 已创建并启动`),
      }),
  });
}

// ── Delete instance (two-step: select → confirm) ──

export function showDeleteInstancePicker(deps: OverlayFlowDeps): void {
  const { scheduler, dataSource, pushSystemMessage, instanceIdRef } = deps;
  const currentInstId = instanceIdRef.current;
  scheduler.push({
    id: "delete-instance-picker",
    kind: "select",
    layout: "fullscreen",
    title: "选择要删除的 Instance",
    loadItems: makeInstanceLoadItems(dataSource, {
      disabled: i => i.id === currentInstId,
      mapItem: (i, item) => i.id === currentInstId
        ? { ...item, hint: `[当前] [${i.status}]` }
        : item,
    }),
    onConfirm: (_idx, item) => {
      const targetId = item.label;
      pushConfirm(scheduler, {
        id: "delete-instance-confirm",
        title: `确认删除 Instance "${targetId}"？`,
        confirmLabel: "确认删除（不可恢复）",
        onConfirm: () => {
          scheduler.clear();
          dataSource.freeInstance(targetId)
            .then(() => pushSystemMessage(`🗑  Instance "${targetId}" 已删除`))
            .catch(e => pushSystemMessage(`❌ 删除失败: ${e instanceof Error ? e.message : String(e)}`));
        },
      });
    },
  });
}

// ── Restart with retry loop ──

function attemptRestart(
  deps: OverlayFlowDeps,
  instanceId: string,
  setInstanceId: ((id: string) => void) | undefined,
): void {
  const { scheduler, dataSource, pushSystemMessage } = deps;

  scheduler.push({
    id: "instance-restart",
    kind: "select",
    layout: "modal",
    title: `正在重启 "${instanceId}"...`,
    items: [{ label: "请稍候...", disabled: true }],
  });

  dataSource.restartInstance(instanceId)
    .then(() => {
      pushSystemMessage(`✅ Instance "${instanceId}" 已重启`);
      scheduler.clear();
      setInstanceId?.(instanceId);
    })
    .catch(e => {
      const msg = e instanceof Error ? e.message : String(e);
      scheduler.push({
        id: "instance-restart",
        kind: "select",
        layout: "modal",
        title: `重启 "${instanceId}" 失败: ${msg}`,
        items: [
          { label: "重试", hint: "再次重启" },
          { label: "返回", hint: "返回 Instance 列表" },
        ],
        onConfirm: (idx) => {
          if (idx !== 0) return;
          attemptRestart(deps, instanceId, setInstanceId);
        },
      });
    });
}

// ── Instance picker (with create/delete actions) ──

export function showInstancePicker(
  deps: OverlayFlowDeps,
  setInstanceId: ((id: string) => void) | undefined,
): void {
  const { scheduler, dataSource } = deps;

  // Cache enough of each instance to drive Enter routing without another fetch.
  // For idle instances we route Enter based on hasTeam: true → restart, false →
  // pack picker.
  const instanceMetaMap = new Map<string, { status: string; hasTeam: boolean }>();

  scheduler.push({
    id: "instance-picker",
    kind: "select",
    layout: "fullscreen",
    title: "选择 Instance",
    loadItems: async () => {
      const instances = await dataSource.listInstances();
      instanceMetaMap.clear();
      for (const i of instances) {
        instanceMetaMap.set(i.id, { status: i.status, hasTeam: i.hasTeam ?? true });
      }

      return [
        ...buildInstanceItems(instances, {
          disabled: i => !selectable(i) && !RESTARTABLE_STATUSES.has(i.status),
          mapItem: (i, item) => {
            if (!RESTARTABLE_STATUSES.has(i.status)) return item;
            const meta = instanceMetaMap.get(i.id);
            const hint = i.status === "idle" && meta && !meta.hasTeam
              ? `${item.hint}  ⏎ Enter 选 team`
              : `${item.hint}  ⏎ Enter 重启`;
            return { ...item, hint };
          },
        }),
        { label: ACTION_CREATE },
        { label: ACTION_DELETE },
      ];
    },
    pollMs: 3000,
    onConfirm: (_idx, item) => {
      if (item.label === ACTION_CREATE) {
        showCreateInstance(deps);
        return;
      }
      if (item.label === ACTION_DELETE) {
        showDeleteInstancePicker(deps);
        return;
      }

      const meta = instanceMetaMap.get(item.label);
      if (!meta) {
        setInstanceId?.(item.label);
        return;
      }

      // idle without team → route to the pack picker; user must pick a team
      // before the instance can run.
      if (meta.status === "idle" && !meta.hasTeam) {
        showLoadPackForInstance(deps, item.label);
        return;
      }

      // error / idle (with team) → manual restart.
      if (RESTARTABLE_STATUSES.has(meta.status)) {
        attemptRestart(deps, item.label, setInstanceId);
        return;
      }

      setInstanceId?.(item.label);
    },
  });
}

// ── Load pack into instance (select instance → select pack → confirm) ──

const ACTION_CREATE_PACK = "➕ 新建空 Pack";

function showPackPickerForInstance(deps: OverlayFlowDeps, targetInstId: string): void {
  const { scheduler, dataSource, pushSystemMessage, handleInstanceSwitch } = deps;
  scheduler.push({
    id: "load-pack-pack-picker",
    kind: "select",
    layout: "fullscreen",
    title: `选择要加载到 "${targetInstId}" 的 Pack`,
    loadItems: async () => {
      const packs = await dataSource.listPacks();
      const items = packs.map(p => ({
        label: p.id,
        hint: `${p.version ? `v${p.version}` : ""} ${p.isBuilt ? "[已构建]" : "[未构建]"}`.trim(),
        hintColor: p.isBuilt ? C.green : C.blackBright,
      }));
      // 末尾追加"新建空 pack"动作项
      items.push({ label: ACTION_CREATE_PACK, hint: "新建一个最小 scaffold 的 pack 并加载到此 instance", hintColor: C.cyan });
      return items;
    },
    onConfirm: (_pidx, packItem) => {
      // "新建空 pack" 分支：弹输入框收 packId → createPack → 用新 packId 走 teamLoad
      if (packItem.label === ACTION_CREATE_PACK) {
        scheduler.push({
          id: "create-pack-name",
          kind: "panel",
          layout: "fullscreen",
          title: "新建空 Pack",
          render: () =>
            React.createElement(TextInputPanel, {
              prompt: "输入新 Pack 名称:",
              onSubmit: (newPackId: string) => {
                scheduler.clear();
                handleInstanceSwitch?.("");
                pushSystemMessage(`⏳ 正在创建空 Pack "${newPackId}" 并加载到 "${targetInstId}"...`);
                dataSource.createPack(newPackId)
                  .then(() => dataSource.teamLoad(targetInstId, newPackId))
                  .then(() => pushSystemMessage(`✅ 空 Pack "${newPackId}" 已创建并加载到 Instance "${targetInstId}"`))
                  .catch(e => pushSystemMessage(`❌ 创建/加载失败: ${e instanceof Error ? e.message : String(e)}`));
              },
            }),
        });
        return;
      }

      const packId = packItem.label;
      scheduler.push({
        id: "load-pack-confirm",
        kind: "select",
        layout: "fullscreen",
        title: `加载 Pack "${packId}" 到 Instance "${targetInstId}"`,
        items: [
          { label: "直接加载", hint: "覆盖现有 team（会自动备份）" },
          { label: "Fork 加载", hint: "创建 Pack 副本后加载" },
          { label: "取消" },
        ],
        onConfirm: (confirmIdx) => {
          if (confirmIdx >= 2) return;
          if (confirmIdx === 0) {
            scheduler.clear();
            handleInstanceSwitch?.("");
            pushSystemMessage(`⏳ 正在加载 Pack "${packId}" 到 "${targetInstId}"...`);
            dataSource.teamLoad(targetInstId, packId)
              .then(() => pushSystemMessage(`✅ Pack "${packId}" 已加载到 Instance "${targetInstId}"`))
              .catch(e => pushSystemMessage(`❌ 加载失败: ${e instanceof Error ? e.message : String(e)}`));
            return;
          }
          scheduler.push({
            id: "load-pack-fork-name",
            kind: "panel",
            layout: "fullscreen",
            title: `Fork Pack "${packId}"`,
            render: () =>
              React.createElement(TextInputPanel, {
                prompt: "输入 Fork Pack 名称:",
                defaultValue: `${packId}-${targetInstId}`,
                onSubmit: (forkId: string) => {
                  scheduler.clear();
                  handleInstanceSwitch?.("");
                  pushSystemMessage(`⏳ 正在 Fork 并加载 Pack "${packId}" → "${forkId}" 到 "${targetInstId}"...`);
                  dataSource.teamLoad(targetInstId, packId, forkId)
                    .then(() => pushSystemMessage(`✅ Pack "${packId}" 已 Fork 为 "${forkId}" 并加载到 Instance "${targetInstId}"`))
                    .catch(e => pushSystemMessage(`❌ 加载失败: ${e instanceof Error ? e.message : String(e)}`));
                },
              }),
          });
        },
      });
    },
  });
}

export function showLoadPackForInstance(deps: OverlayFlowDeps, instanceId: string): void {
  showPackPickerForInstance(deps, instanceId);
}

export function showLoadPack(deps: OverlayFlowDeps): void {
  const { scheduler, dataSource } = deps;
  scheduler.push({
    id: "load-pack-instance-picker",
    kind: "select",
    layout: "fullscreen",
    title: "选择要加载 Pack 的 Instance",
    loadItems: makeInstanceLoadItems(dataSource),
    onConfirm: (_idx, instItem) => {
      showPackPickerForInstance(deps, instItem.label);
    },
  });
}

// ── Restore team backup (select instance → select backup → confirm) ──

export function showTeamRestore(deps: OverlayFlowDeps): void {
  const { scheduler, dataSource, pushSystemMessage } = deps;
  scheduler.push({
    id: "restore-instance-picker",
    kind: "select",
    layout: "fullscreen",
    title: "选择要恢复备份的 Instance",
    loadItems: makeInstanceLoadItems(dataSource),
    onConfirm: (_idx, instItem) => {
      const targetInstId = instItem.label;
      scheduler.push({
        id: "restore-backup-picker",
        kind: "select",
        layout: "fullscreen",
        title: `选择要恢复到 "${targetInstId}" 的备份`,
        loadItems: async () => {
          const info = await dataSource.fetchTeamInfo(targetInstId);
          if (info.backups.length === 0) {
            return [{ label: "（无可用备份）", disabled: true }];
          }
          return info.backups.map(b => ({
            label: b,
            hint: info.team?.source ? `当前: ${info.team.source.id} v${info.team.source.version}` : undefined,
          }));
        },
        onConfirm: (_bidx, backupItem) => {
          if (backupItem.disabled) return;
          const backupName = backupItem.label;
          pushConfirm(scheduler, {
            id: "restore-confirm",
            title: `确认恢复备份 "${backupName}" 到 "${targetInstId}"？`,
            confirmLabel: "确认恢复（将关闭实例并替换 team）",
            onConfirm: () => {
              scheduler.clear();
              pushSystemMessage(`⏳ 正在恢复备份 "${backupName}" 到 "${targetInstId}"...`);
              dataSource.teamRestore(targetInstId, backupName)
                .then(() => pushSystemMessage(`✅ 备份 "${backupName}" 已恢复到 Instance "${targetInstId}"，实例已重启`))
                .catch(e => pushSystemMessage(`❌ 恢复失败: ${e instanceof Error ? e.message : String(e)}`));
            },
          });
        },
      });
    },
  });
}
