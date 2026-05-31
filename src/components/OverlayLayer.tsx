/**
 * OverlayLayer — reads scheduler state and renders the matching overlay component.
 * Dispatches to ScrollableSelectList for "select" kind, PanelOverlay for "panel" kind.
 */

import React from "react";
import { PanelOverlay } from "./PanelOverlay.js";
import { ScrollableSelectList } from "./ScrollableSelectList.js";
import type { OverlaySchedulerResult } from "../hooks/use-overlay-scheduler.js";

interface OverlayLayerProps {
  scheduler: OverlaySchedulerResult;
}

export function OverlayLayer({ scheduler }: OverlayLayerProps): React.JSX.Element | null {
  const { current, isLoading, items, confirm, cancel } = scheduler;

  if (!current) return null;

  let content: React.JSX.Element | null = null;

  if (current.kind === "panel" && current.render) {
    content = (
      <PanelOverlay key={current.id} title={current.title} onClose={cancel}>
        {current.render(cancel)}
      </PanelOverlay>
    );
  } else if (current.kind === "select") {
    content = (
      <ScrollableSelectList
        key={current.id}
        title={current.title}
        items={items}
        layout={current.layout ?? "modal"}
        isLoading={isLoading}
        onConfirm={confirm}
        onCancel={cancel}
      />
    );
  }

  if (!content) return null;

  return content;
}
