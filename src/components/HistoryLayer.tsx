/**
 * HistoryLayer — scrollable history area wrapping VirtualMessageList.
 * Occupies flexGrow=1 of the available vertical space.
 *
 * React.memo prevents re-renders from sibling state changes (Spinner ticks,
 * isThinking, agentStatus, overlay state) that don't affect the message list.
 *
 * Key routing (mirrors Claude Code):
 *   - Home / End             → input cursor (handled in InputBox)
 *   - Ctrl+Home / Ctrl+End   → history scroll top / bottom (handled globally
 *                              in use-scroll-keys via useInput)
 *   - PageUp / PageDown      → half-viewport jump (use-scroll-keys)
 *   - JumpToBottomBanner     → click-to-bottom affordance when scrolled up
 *
 * No tabIndex/onKeyDown here on purpose: clicks on history must NOT steal
 * focus from the input, since scroll keys now work without focus.
 */

import React, { memo, type RefObject } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as ScrollBox, type ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { VirtualMessageList } from "./VirtualMessageList.js";
import { JumpToBottomBanner } from "./JumpToBottomBanner.js";
import type { CompletedTurn } from "../types.js";

interface HistoryLayerProps {
  turns: CompletedTurn[];
  scrollRef: RefObject<ScrollBoxHandle | null>;
  columns: number;
  streamText: string;
}

export const HistoryLayer = memo(function HistoryLayer({
  turns,
  scrollRef,
  columns,
  streamText,
}: HistoryLayerProps): React.JSX.Element {
  return (
    <Box flexGrow={1} flexDirection="column">
      <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" stickyScroll={true}>
        <VirtualMessageList turns={turns} scrollRef={scrollRef} columns={columns} streamText={streamText} />
        <Box flexGrow={1} />
      </ScrollBox>
      <JumpToBottomBanner scrollRef={scrollRef} />
    </Box>
  );
});
