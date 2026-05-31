/**
 * ScrollableSelectList — select overlay with viewport scrolling for long lists.
 *
 * Used by OverlayLayer for all scheduler "select" overlays (/switch-session,
 * /instance, agent picker, …). Scrolls when the list exceeds the terminal
 * budget (modal overlays use the bottom-half row budget from ScreenLayout).
 */

import React, { useState } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import { SELECT_LIST_CHROME_OVERHEAD } from "../lib/scrollable-list-viewport.js";
import { useScrollableListViewport } from "../hooks/use-scrollable-list-viewport.js";
import { ScrollableListFrame, scrollableListNavHint } from "./ScrollableListFrame.js";
import { theme } from "../lib/theme.js";
import type { OverlayLayout, SelectItem } from "../types.js";

export interface ScrollableSelectListProps {
  title: string;
  items: SelectItem[];
  layout?: OverlayLayout;
  isLoading?: boolean;
  onConfirm: (idx: number) => void;
  onCancel: () => void;
}

function findNextEnabled(items: SelectItem[], from: number, dir: 1 | -1): number {
  let i = from;
  while (i >= 0 && i < items.length) {
    if (!items[i]!.disabled) return i;
    i += dir;
  }
  return -1;
}

export function ScrollableSelectList({
  title,
  items,
  layout = "modal",
  isLoading = false,
  onConfirm,
  onCancel,
}: ScrollableSelectListProps): React.JSX.Element {
  const firstEnabled = items.findIndex((it) => !it.disabled);
  const [idx, setIdx] = useState(Math.max(0, firstEnabled));
  const [confirming, setConfirming] = useState(false);
  const { slice, rowBudget } = useScrollableListViewport();

  const safeIdx = items.length > 0 ? Math.min(Math.max(0, idx), items.length - 1) : 0;
  const viewport = slice({
    itemCount: items.length,
    cursorIndex: safeIdx,
    rowBudget: rowBudget(layout),
    chromeOverhead: SELECT_LIST_CHROME_OVERHEAD,
  });

  useInput((_input, key) => {
    if (isLoading || confirming) return;
    if (key.upArrow) {
      setIdx((cur) => {
        const next = findNextEnabled(items, cur - 1, -1);
        return next >= 0 ? next : cur;
      });
    }
    if (key.downArrow) {
      setIdx((cur) => {
        const next = findNextEnabled(items, cur + 1, 1);
        return next >= 0 ? next : cur;
      });
    }
    if (key.return && items.length > 0 && !items[safeIdx]?.disabled) {
      setConfirming(true);
      onConfirm(safeIdx);
    }
    if (key.escape) onCancel();
  });

  const visibleItems = items.slice(viewport.start, viewport.end);

  return (
    <Box flexDirection="column" borderStyle={theme.overlay.borderStyle} borderColor={theme.overlay.borderColor}>
      <Text bold> {title} </Text>
      {isLoading ? (
        <Text color={theme.overlay.loadingColor}> 加载中...</Text>
      ) : items.length === 0 ? (
        <Text dimColor> 无可用选项</Text>
      ) : (
        <ScrollableListFrame slice={viewport}>
          {visibleItems.map((item, viewportIdx) => {
            const i = viewport.start + viewportIdx;
            const selected = i === safeIdx;
            const disabled = !!item.disabled;
            return (
              <Box key={i}>
                <Text color={disabled ? theme.overlay.disabledColor : selected ? theme.overlay.selectedColor : undefined}>
                  {selected ? `${theme.overlay.selectedChar} ` : "  "}
                </Text>
                <Text bold={selected && !disabled} dimColor={disabled} strikethrough={disabled}>
                  {item.label}
                </Text>
                {item.hint ? (
                  <Text
                    color={disabled ? theme.overlay.disabledColor : (item.hintColor as string | undefined) ?? undefined}
                    dimColor={disabled && !item.hintColor}
                  >
                    {" "}{item.hint}
                  </Text>
                ) : null}
              </Box>
            );
          })}
        </ScrollableListFrame>
      )}
      {confirming ? (
        <Text color={theme.overlay.loadingColor}> 处理中...</Text>
      ) : (
        <Text dimColor>
          {scrollableListNavHint(viewport.needsScroll, safeIdx + 1, items.length, "Enter 确认  Esc 取消")}
        </Text>
      )}
    </Box>
  );
}
