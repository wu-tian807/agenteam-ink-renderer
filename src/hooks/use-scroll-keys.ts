/**
 * Scroll keybinding hook — maps keyboard/wheel events to ScrollBox API.
 *
 * Orchestrates wheel-acceleration (pure math), drag-to-scroll (auto-scroll
 * on selection drag), and keyboard navigation (PageUp/Down, Ctrl+Home/End).
 *
 * Key routing convention (mirrors Claude Code):
 *   - Home / End                  → input-box cursor (line start / end)
 *   - Ctrl+Home / Ctrl+End        → scroll history to top / bottom
 *   - PageUp / PageDown           → scroll history by half a viewport
 *   - Wheel (mode-1003 SGR)       → smooth wheel scroll with acceleration
 *
 * Splitting on the Ctrl modifier (instead of focus state) avoids the
 * dual-trigger pitfall where pressing End in the input box would both move
 * the cursor AND jump the scroll viewport. It also matches what users learn
 * from chat clients / browsers / IDEs.
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import useInput from '../ink/hooks/use-input.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { useSelection } from '../ink/hooks/use-selection.js'
import { useCopyOnSelect } from './use-copy-on-select.js'
import { getTheme } from '../utils/theme.js'
import { useTheme } from '../ink/ink-compat.js'
import {
  type WheelAccelState,
  initWheelAccel,
  computeWheelStep,
  isXtermJs,
  readScrollSpeedBase,
  jumpBy,
  scrollDown,
  scrollUp,
} from './wheel-acceleration.js'
import { useDragToScroll } from './use-drag-to-scroll.js'

export { type WheelAccelState, computeWheelStep, initWheelAccel, jumpBy }
export { dragScrollDirection } from './use-drag-to-scroll.js'

export interface ScrollKeysResult {
  hasSelection: () => boolean;
  copySelection: () => string;
  clearSelection: () => void;
}

export function useScrollKeys(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  isActive: boolean,
): ScrollKeysResult {
  const wheelAccel = useRef<WheelAccelState | null>(null)
  const selection = useSelection()

  const [themeName] = useTheme()
  useEffect(() => {
    const theme = getTheme(themeName)
    selection.setSelectionBgColor(theme.selectionBg)
  }, [themeName, selection])

  useCopyOnSelect(selection, isActive)
  useDragToScroll(scrollRef, selection, isActive)

  useInput((input, key) => {
    const sb = scrollRef.current
    if (!sb) return

    if (key.escape && selection.hasSelection()) {
      selection.clearSelection()
      return
    }

    if (key.ctrl && key.home) {
      // Ctrl+Home: jump to the top of history (input cursor unaffected,
      // because plain Home is consumed by InputBox's onKeyDown).
      selection.clearSelection()
      sb.scrollTo(0)
    } else if (key.ctrl && key.end) {
      // Ctrl+End: jump back to bottom and re-pin sticky scroll so new
      // content auto-follows. Matches the JumpToBottomBanner click target.
      selection.clearSelection()
      sb.scrollToBottom()
    } else if (key.pageUp) {
      selection.clearSelection()
      const d = -Math.max(1, Math.floor(sb.getViewportHeight() / 2))
      jumpBy(sb, d)
    } else if (key.pageDown) {
      selection.clearSelection()
      const d = Math.max(1, Math.floor(sb.getViewportHeight() / 2))
      jumpBy(sb, d)
    } else if (key.wheelUp) {
      if (sb.getScrollHeight() <= sb.getViewportHeight()) return
      wheelAccel.current ??= initWheelAccel(isXtermJs(), readScrollSpeedBase())
      const step = computeWheelStep(wheelAccel.current, -1, performance.now())
      scrollUp(sb, step)
    } else if (key.wheelDown) {
      if (sb.getScrollHeight() <= sb.getViewportHeight()) return
      wheelAccel.current ??= initWheelAccel(isXtermJs(), readScrollSpeedBase())
      const step = computeWheelStep(wheelAccel.current, 1, performance.now())
      scrollDown(sb, step)
    }
    // Plain Home/End deliberately omitted — they belong to the input-box
    // cursor. Ctrl+Home/Ctrl+End above are the scroll equivalents.
  }, { isActive })

  return {
    hasSelection: selection.hasSelection,
    copySelection: selection.copySelection,
    clearSelection: selection.clearSelection,
  }
}
