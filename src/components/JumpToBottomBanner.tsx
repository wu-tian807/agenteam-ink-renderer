/**
 * JumpToBottomBanner — Claude Code-style centred "jump to bottom" pill.
 *
 * Surfaces a click-to-bottom affordance whenever the user has scrolled
 * away from the tail. Subscribes to the ScrollBox via `subscribe()` +
 * useSyncExternalStore so visibility flips synchronously with imperative
 * scroll events, without re-rendering the message list above.
 *
 * Layout note (load-bearing — DO NOT switch back to position="absolute"):
 *   Earlier revisions floated this pill as `position="absolute" bottom=0`
 *   over the ScrollBox so the banner never "ate" a row from the chat
 *   transcript. That worked visually but corrupted the renderer's
 *   fast-scroll path: the banner's cells lived in the same row range as
 *   the ScrollBox viewport, so output.blit + output.shift (DECSTBM) in
 *   render-node-to-output.ts:921+ copied the pill into the prevScreen
 *   region and then shifted those cells UP into the middle of the
 *   transcript on the next scroll. The third-pass repair at
 *   render-node-to-output.ts:1067 only fires on safeForFastPath frames
 *   (heightDelta == 0 || bottom-append) — during streaming + scroll-up
 *   the heightDelta != delta branch silently skipped repair, leaving a
 *   pill-shaped grey ghost across the table rows above ("续"/"查"
 *   汉字 vanished where the pill rect landed).
 *
 *   The fix is structural: render the banner as a NORMAL-FLOW row that
 *   sits OUTSIDE the ScrollBox's viewport. HistoryLayer becomes
 *   ScrollBox(flexGrow=1) + this 1-row Box. When the pill mounts,
 *   ScrollBox loses one row of inner height but the pill cells live in
 *   their own dedicated screen row that the ScrollBox blit/shift never
 *   touches. removeChildNode for a non-absolute node walks the
 *   normal-flow `hasRemovedChild` path (no `absoluteNodeRemoved` flag,
 *   so prevScreen survives, fast-path scroll keeps working) and
 *   pendingClears handles wiping the row on unmount.
 *
 *   Cost: a tiny 1-row reflow when the pill appears/disappears, mostly
 *   imperceptible because the user is by definition NOT looking at the
 *   bottom row when the pill is visible (it only shows after scroll-up).
 */

import React, { useCallback, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import type { Color } from "../ink/styles.js";
import { useTheme } from "../ink/ink-compat.js";
import { getTheme } from "../utils/theme.js";

interface JumpToBottomBannerProps {
  scrollRef: RefObject<ScrollBoxHandle | null>;
}

/**
 * Hidden-row threshold below the viewport before the pill appears.
 * A tiny accidental wheel-up shouldn't pop the banner; anything beyond
 * a couple of rows definitely should. Matches typical chat UX.
 */
const HIDDEN_ROWS_THRESHOLD = 2;

/**
 * Pill label. The pre/post spaces give the pill a 1-cell padding around
 * the text so the highlight reads as a button rather than a flat run.
 * Kept ASCII + a single BMP arrow so wcwidth == .length (no wcswidth).
 */
const PILL_TEXT = " Jump to bottom \u2193 (Ctrl+End) ";

const NOOP_UNSUB = () => {};

export function JumpToBottomBanner({
  scrollRef,
}: JumpToBottomBannerProps): React.JSX.Element | null {
  const [hover, setHover] = useState(false);
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  const subscribe = useCallback(
    (listener: () => void) => scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB,
    [scrollRef],
  );

  // Boolean snapshot — only flips when crossing the threshold, so wheel
  // bursts mid-scroll don't churn React. pendingDelta is folded in so the
  // pill appears immediately on the wheel event that broke sticky.
  const visible = useSyncExternalStore(subscribe, () => {
    const sb = scrollRef.current;
    if (!sb) return false;
    if (sb.isSticky()) return false;
    const top = sb.getScrollTop() + sb.getPendingDelta();
    const hidden = sb.getScrollHeight() - sb.getViewportHeight() - top;
    return hidden > HIDDEN_ROWS_THRESHOLD;
  });

  const onClick = useCallback(() => {
    scrollRef.current?.scrollToBottom();
  }, [scrollRef]);

  const onMouseEnter = useCallback(() => setHover(true), []);
  const onMouseLeave = useCallback(() => setHover(false), []);

  if (!visible) return null;

  // Theme stores colors as plain `string` for ergonomics; cast to the
  // template-literal `Color` type the renderer's style props accept.
  const bg = (hover ? theme.userMessageBackgroundHover : theme.userMessageBackground) as Color;

  // Outer row: full-width, height 1, flex-row + justify centre. Yoga
  // gives the pill its intrinsic text width and centres it horizontally.
  // flexShrink=0 prevents the row from collapsing when the parent runs
  // tight on space (we want the pill to remain interactive).
  //
  // Inner Box owns the click/hover handlers so only the pill rectangle
  // is interactive — clicking the empty gutter to either side does
  // nothing, matching how the user perceives the "button".
  return (
    <Box
      flexShrink={0}
      height={1}
      flexDirection="row"
      justifyContent="center"
    >
      <Box
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <Text backgroundColor={bg} dim>
          {PILL_TEXT}
        </Text>
      </Box>
    </Box>
  );
}
