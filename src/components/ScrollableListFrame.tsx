/**
 * ScrollableListFrame — shared ↑/↓ overflow indicators around a list body.
 *
 * Pair with ScrollableListViewport.slice() output; keeps indicator copy
 * consistent across select overlays, /model, /agents, and suggestions.
 */

import React from "react";
import { default as Text } from "../ink/components/Text.js";
import type { ScrollableViewportSlice } from "../lib/scrollable-list-viewport.js";

export interface ScrollableListFrameProps {
  slice: Pick<ScrollableViewportSlice, "needsScroll" | "aboveCount" | "belowCount">;
  children: React.ReactNode;
}

export function ScrollableListFrame({ slice, children }: ScrollableListFrameProps): React.JSX.Element {
  const { needsScroll, aboveCount, belowCount } = slice;
  return (
    <>
      {needsScroll ? (
        <Text dimColor>{aboveCount > 0 ? `  ↑ 还有 ${aboveCount} 个` : "  "}</Text>
      ) : null}
      {children}
      {needsScroll ? (
        <Text dimColor>{belowCount > 0 ? `  ↓ 还有 ${belowCount} 个` : "  "}</Text>
      ) : null}
    </>
  );
}

/** Footer hint when the list uses viewport scrolling. */
export function scrollableListNavHint(
  needsScroll: boolean,
  cursorOneBased: number,
  total: number,
  actions: string,
): string {
  if (needsScroll && total > 0) {
    return `↑↓ 移动 (${cursorOneBased}/${total})  ${actions}`;
  }
  return `↑↓ 移动  ${actions}`;
}
