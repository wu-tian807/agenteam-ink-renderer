/** @desc Shared helpers for overlay-flow item construction and confirmations. */

import type { ProvisioningPhase, InstanceStatus, ContainerStatus } from "@agenteam/types";
import { PROVISIONING_PHASE_LABEL, displayStatus } from "@agenteam/types";
import { C } from "../../lib/colors.js";
import { theme } from "../../lib/theme.js";
import type { RendererDataSource, SelectItem, OverlayLayout } from "../../types.js";
import type { OverlaySchedulerResult } from "../use-overlay-scheduler.js";

type InstanceLike = { id: string; status: string; statusMessage?: string; provisioningPhase?: string; containerStatus?: string };

// The instance + container are two state machines; `displayStatus` collapses
// them into the single status the picker should surface (see @agenteam/types).
function viewStatus(i: InstanceLike): InstanceStatus | "provisioning" {
  return displayStatus({ status: i.status as InstanceStatus, containerStatus: i.containerStatus as ContainerStatus | undefined });
}

export function formatInstanceHint(i: InstanceLike): string {
  const disp = viewStatus(i);
  if (disp === "provisioning") {
    const label = i.provisioningPhase ? PROVISIONING_PHASE_LABEL[i.provisioningPhase as ProvisioningPhase] : undefined;
    return label ? `[provisioning] ${label}` : `[provisioning]`;
  }
  return `[${disp}]${i.statusMessage ? ` ${i.statusMessage}` : ""}`;
}

export function instanceHintColor(i: InstanceLike): string {
  return theme.instanceStatus[viewStatus(i) as keyof typeof theme.instanceStatus] ?? C.blackBright;
}

/** Map an instance list into SelectItems with consistent hint + hintColor. */
export function buildInstanceItems(
  instances: InstanceLike[],
  opts?: {
    disabled?: (i: InstanceLike) => boolean;
    mapItem?: (i: InstanceLike, item: SelectItem) => SelectItem;
  },
): SelectItem[] {
  return instances.map(i => {
    const item: SelectItem = {
      label: i.id,
      hint: formatInstanceHint(i),
      hintColor: instanceHintColor(i),
      disabled: opts?.disabled?.(i),
    };
    return opts?.mapItem ? opts.mapItem(i, item) : item;
  });
}

export function makeInstanceLoadItems(
  dataSource: RendererDataSource,
  opts?: Parameters<typeof buildInstanceItems>[1],
): () => Promise<SelectItem[]> {
  return async () => buildInstanceItems(await dataSource.listInstances!(), opts);
}

export function pushConfirm(
  scheduler: OverlaySchedulerResult,
  opts: {
    id: string;
    title: string;
    confirmLabel: string;
    confirmHint?: string;
    cancelLabel?: string;
    layout?: OverlayLayout;
    onConfirm: () => void;
  },
): void {
  scheduler.push({
    id: opts.id,
    kind: "select",
    layout: opts.layout ?? "fullscreen",
    title: opts.title,
    items: [
      { label: opts.confirmLabel, hint: opts.confirmHint },
      { label: opts.cancelLabel ?? "取消" },
    ],
    onConfirm: (idx) => {
      if (idx !== 0) return;
      opts.onConfirm();
    },
  });
}
