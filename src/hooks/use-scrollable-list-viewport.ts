/**
 * useScrollableListViewport — React hook wrapping ScrollableListViewport + terminal size.
 */

import { useRef } from "react";
import { useTerminalSize } from "./use-terminal-size.js";
import {
  ScrollableListViewport,
  type ScrollableViewportInput,
  type ScrollableViewportSlice,
  overlayRowBudget,
} from "../lib/scrollable-list-viewport.js";
import type { OverlayLayout } from "../types.js";

export function useScrollableListViewport(): {
  slice: (input: ScrollableViewportInput) => ScrollableViewportSlice;
  terminalRows: number;
  rowBudget: (layout?: OverlayLayout) => number;
  reset: () => void;
} {
  const viewportRef = useRef<ScrollableListViewport | null>(null);
  if (!viewportRef.current) viewportRef.current = new ScrollableListViewport();
  const { rows: terminalRows } = useTerminalSize();

  return {
    slice: (input) => viewportRef.current!.slice(input),
    terminalRows,
    rowBudget: (layout: OverlayLayout = "modal") => overlayRowBudget(terminalRows, layout),
    reset: () => viewportRef.current!.reset(),
  };
}
