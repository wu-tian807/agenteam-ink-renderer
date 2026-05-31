/**
 * ScrollableListViewport — viewport math for ink-renderer list overlays.
 *
 * Keeps a sliding window over a long item list so only `visibleCount` rows
 * render at once. `slice()` updates the window synchronously during render
 * (via a ref-backed start index) so the cursor never sits off-screen for a
 * frame — same pattern as ModelChainPanel.
 *
 * Reuse for:
 *   - ScrollableSelectList (all scheduler select overlays)
 *   - ModelChainPanel (/model catalog list)
 *   - AgentTreePicker (/agents)
 *   - CommandSuggestions (input autocomplete, centered window)
 */

import type { OverlayLayout } from "../types.js";

/** `follow`: keep cursor in view (overlay lists). `centered`: cursor near middle (suggestions). */
export type ScrollMode = "follow" | "centered";

export interface ScrollableViewportInput {
  itemCount: number;
  cursorIndex: number;
  /** Rows available to the overlay region (terminal rows or modal half). */
  rowBudget: number;
  /** Rows consumed by chrome around the list (border, title, hints, …). */
  chromeOverhead: number;
  minVisible?: number;
  /** Cap visible rows (e.g. slash suggestions MAX_VISIBLE). */
  maxVisible?: number;
  scrollMode?: ScrollMode;
  /** When true, do not scroll the window to follow cursor (e.g. footer buttons). */
  freezeFollow?: boolean;
}

export interface ScrollableViewportSlice {
  start: number;
  end: number;
  visibleCount: number;
  needsScroll: boolean;
  aboveCount: number;
  belowCount: number;
}

/** Chrome for bordered select overlay: border(2) + title(1) + footer(1) + indicators(2) + safety(1). */
export const SELECT_LIST_CHROME_OVERHEAD = 7;

/**
 * Chrome for panel-body list inside PanelOverlay, with optional fixed footer rows
 * below the scrollable catalog (e.g. /model save buttons).
 */
export function panelListChromeOverhead(fixedFooterRows: number): number {
  // PanelOverlay border(2) + title(1) + "Esc 关闭"(1) + hint margin(1) +
  // footer block + scroll indicators(2) + safety(1)
  return 7 + 1 + fixedFooterRows + 2;
}

/** Row budget for overlay list — modal overlays live in the bottom 50% column. */
export function overlayRowBudget(terminalRows: number, layout: OverlayLayout = "modal"): number {
  return layout === "modal" ? Math.floor(terminalRows / 2) : terminalRows;
}

export class ScrollableListViewport {
  private start = 0;

  reset(): void {
    this.start = 0;
  }

  /**
   * Compute the visible [start, end) slice and persist the new window start.
   * Call once per render while the cursor may have moved.
   */
  slice(input: ScrollableViewportInput): ScrollableViewportSlice {
    const { itemCount, cursorIndex, rowBudget, chromeOverhead } = input;
    const minVisible = input.minVisible ?? 3;
    const scrollMode = input.scrollMode ?? "follow";
    let visibleCount = Math.max(minVisible, rowBudget - chromeOverhead);
    if (input.maxVisible != null) visibleCount = Math.min(visibleCount, input.maxVisible);
    const needsScroll = itemCount > visibleCount;
    const maxStart = Math.max(0, itemCount - visibleCount);

    let start = 0;
    if (needsScroll) {
      const idx = Math.min(Math.max(0, cursorIndex), Math.max(0, itemCount - 1));
      if (scrollMode === "centered") {
        start = Math.max(0, Math.min(idx - Math.floor(visibleCount / 2), maxStart));
      } else {
        start = Math.min(Math.max(0, this.start), maxStart);
        if (!input.freezeFollow) {
          if (idx < start) start = idx;
          else if (idx >= start + visibleCount) start = idx - visibleCount + 1;
        }
      }
    }
    this.start = start;

    const end = needsScroll ? Math.min(itemCount, start + visibleCount) : itemCount;
    return {
      start,
      end,
      visibleCount,
      needsScroll,
      aboveCount: start,
      belowCount: itemCount - end,
    };
  }
}
